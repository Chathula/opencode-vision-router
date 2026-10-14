import { describe, it, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveImagePath, resolveMediaPath, decodeDataUrl, extForMime } from "./image";
import { transformMessages, transformV2Messages, imagePointer, isMediaImagePart } from "./transform";
import { applyConfig, applyAgent, buildVisionAgentConfig, delegationInstruction } from "./agent";
import type { Config } from "@opencode-ai/plugin";
import plugin from "./index";

/** Load the V1 implementation from the dual default export. */
const loadV1 = async (options: any) =>
  (plugin as any).server({}, options) as Promise<any>;

describe("image helpers", () => {
  it("should map common image types to extensions", () => {
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/webp")).toBe("webp");
    expect(extForMime("image/gif")).toBe("gif");
    expect(extForMime("application/octet-stream")).toBe("bin");
  });

  it("should parse base64 data URLs", () => {
    const b64 = Buffer.from("fakeimagebytes").toString("base64");
    const d = decodeDataUrl(`data:image/png;base64,${b64}`);
    expect(d).not.toBeNull();
    expect(d!.mime).toBe("image/png");
    expect(d!.buffer.toString()).toBe("fakeimagebytes");
  });

  it("should return null for non-data URLs", () => {
    expect(decodeDataUrl("/abs/c.png")).toBeNull();
  });

  it("should decode a data: URL to a temp file and return the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "vr-test-"));
    const b64 = Buffer.from("fakeimagebytes").toString("base64");
    const p = resolveImagePath(
      { type: "file", mime: "image/png", url: `data:image/png;base64,${b64}` },
      dir,
    );
    expect(p).toBeTruthy();
    expect(p!.startsWith(dir)).toBe(true);
    expect(existsSync(p!)).toBe(true);
  });

  it("should return file:// and absolute paths directly", () => {
    expect(
      resolveImagePath(
        { type: "file", mime: "image/png", url: "file:///a/b.png" },
        "/tmp",
      ),
    ).toBe("/a/b.png");
    expect(
      resolveImagePath(
        { type: "file", mime: "image/png", url: "/abs/c.png" },
        "/tmp",
      ),
    ).toBe("/abs/c.png");
  });
});

describe("transformMessages", () => {
  it("should replace image file parts on user messages with a pointer", () => {
    const msgs = [
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "what is this?" },
          { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
        ],
      },
    ];
    const out = transformMessages(
      msgs as any,
      "vision",
      mkdtempSync(join(tmpdir(), "vr-test-")),
    ) as any;
    const texts = out[0].parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text);
    expect(out[0].parts.some((p: any) => p.type === "file")).toBe(false);
    expect(
      texts.some(
        (t: string) => t.includes("saved at:") && t.includes("vision"),
      ),
    ).toBe(true);
  });

  it("should leave non-image messages untouched and skip assistant messages", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      {
        info: { role: "assistant" },
        parts: [{ type: "file", mime: "image/png", url: "/x.png" }],
      },
    ];
    const out = transformMessages(msgs as any, "vision", "/tmp") as any;
    expect(out[0].parts[0].text).toBe("hi");
    expect(out[1].parts[0].type).toBe("file"); // unchanged (assistant)
  });

  it("should reference the agent name in the image pointer", () => {
    expect(imagePointer("/tmp/x.png", "vision")).toContain('"vision" subagent');
    expect(imagePointer("/tmp/x.png", "vision")).toContain("/tmp/x.png");
  });
});

describe("agent config injection", () => {
  it("should produce a subagent with read-only permissions", () => {
    const cfg = buildVisionAgentConfig({ model: "p/m", agent: "vision" });
    expect(cfg.mode).toBe("subagent");
    expect(cfg.model).toBe("p/m");
    expect(cfg.permission.external_directory).toBe("allow");
    expect(cfg.permission.bash).toBe("deny");
  });

  it("should inject provider modalities and the agent", () => {
    const cfg: any = {};
    applyConfig(cfg as Config, { model: "opencode-go/qwen3.7-plus", agent: "vision" });
    expect(cfg.provider["opencode-go"].models["qwen3.7-plus"].attachment).toBe(true);
    expect(
      cfg.provider["opencode-go"].models["qwen3.7-plus"].modalities.input,
    ).toContain("image");
    expect(cfg.agent.vision.mode).toBe("subagent");
  });

  it("should be a no-op without a model", () => {
    const cfg: any = {};
    applyConfig(cfg as Config, {});
    expect(cfg.provider).toBeUndefined();
  });

  it("should name the agent in the delegation instruction", () => {
    expect(delegationInstruction("vision")).toContain('"vision" subagent');
  });
});

describe("plugin routing per model capability", () => {
  const imgParts = () => [
    { type: "text", text: "what is this?" },
    { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
  ];

  // Simulate one user turn: learn capability via chat.params, then rewrite via chat.message.
  const turn = async (
    hooks: any,
    modelID: string,
    capsImage: boolean,
  ) => {
    await hooks["chat.params"]({
      model: {
        id: modelID,
        capabilities: { input: { text: true, image: capsImage }, output: { text: true } },
      },
    });
    const out: any = { parts: imgParts() };
    await hooks["chat.message"]({ model: { modelID }, agent: "main" }, out);
    return out;
  };

  it("should skip the subagent when the main model is multimodal (default)", async () => {
    const hooks = (await loadV1({ model: "p/v" })) as any;
    const out = await turn(hooks, "m", true);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(true); // image intact
  });

  it("should route when the main model is text-only", async () => {
    const hooks = (await loadV1({ model: "p/v" })) as any;
    const out = await turn(hooks, "m", false);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(false); // stripped
    expect(
      out.parts.some(
        (p: any) => p.type === "text" && p.text.includes("[The user attached an image"),
      ),
    ).toBe(true); // pointer added
  });

  it("should route even on a multimodal main model when force is true", async () => {
    const hooks = (await loadV1({ model: "p/v", force: true })) as any;
    const out = await turn(hooks, "m", true);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(false); // stripped
  });

  it("should switch routing when the model changes mid-session", async () => {
    const hooks = (await loadV1({ model: "p/v" })) as any;
    let out = await turn(hooks, "multi", true);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(true); // multimodal: skip
    out = await turn(hooks, "text", false);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(false); // text-only: route
    out = await turn(hooks, "multi", true);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(true); // back to multimodal: skip
  });

  it("should disable routing entirely without a model", async () => {
    const hooks = (await loadV1({})) as any;
    const out: any = { parts: imgParts() };
    await hooks["chat.message"]({ model: { modelID: "m" } }, out);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(true); // untouched
  });

  it("should not rewrite the subagent's own messages", async () => {
    const hooks = (await loadV1({ model: "p/v" })) as any;
    await hooks["chat.params"]({
      model: { id: "multi", capabilities: { input: { image: true }, output: {} } },
    });
    const out: any = { parts: imgParts() };
    await hooks["chat.message"]({ model: { modelID: "multi" }, agent: "vision" }, out);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(true); // untouched
  });
});

describe("OpenCode V2 media helpers", () => {
  it("should materialize V2 media bytes (base64 string) to a temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vr-test-"));
    const b64 = Buffer.from("fakeimagebytes").toString("base64");
    const p = resolveMediaPath(
      { type: "media", mediaType: "image/png", data: b64 },
      dir,
    );
    expect(p).toBeTruthy();
    expect(p!.startsWith(dir)).toBe(true);
    expect(existsSync(p!)).toBe(true);
    expect(p!.endsWith(".png")).toBe(true);
  });

  it("should materialize V2 media bytes (Uint8Array) to a temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vr-test-"));
    const p = resolveMediaPath(
      { type: "media", mediaType: "image/jpeg", data: new Uint8Array([1, 2, 3]) },
      dir,
    );
    expect(p).toBeTruthy();
    expect(p!.endsWith(".jpg")).toBe(true);
  });

  it("should prefer a file path from V2 media metadata", () => {
    expect(
      resolveMediaPath(
        {
          type: "media",
          mediaType: "image/png",
          data: "AAAA",
          metadata: { source: "file:///orig/x.png" },
        },
        "/tmp",
      ),
    ).toBe("/orig/x.png");
    expect(
      resolveMediaPath(
        {
          type: "media",
          mediaType: "image/png",
          data: "AAAA",
          metadata: { path: "/orig/y.png" },
        },
        "/tmp",
      ),
    ).toBe("/orig/y.png");
  });

  it("should fall back to the filename when nothing else resolves", () => {
    expect(
      resolveMediaPath({ type: "media", mediaType: "image/png", filename: "z.png" }),
    ).toBe("z.png");
  });

  it("should handle the opencode >= 2.0.x nested media shape (source.type base64)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vr-test-"));
    const b64 = Buffer.from("nestedimagebytes").toString("base64");
    const p = resolveMediaPath(
      {
        type: "media",
        media: { source: { type: "base64", data: b64, mediaType: "image/png" } },
        filename: "shot.png",
      } as any,
      dir,
    );
    expect(p).toBeTruthy();
    expect(p!.startsWith(dir)).toBe(true);
    expect(existsSync(p!)).toBe(true);
    expect(p!.endsWith(".png")).toBe(true);
  });

  it("should resolve file:// and absolute paths from the nested source", () => {
    expect(
      resolveMediaPath({
        type: "media",
        media: { source: { type: "file", uri: "file:///orig/a.png" } },
      } as any),
    ).toBe("/orig/a.png");
    expect(
      resolveMediaPath({
        type: "media",
        media: { source: { type: "url", url: "/orig/b.png" } },
      } as any),
    ).toBe("/orig/b.png");
  });

  it("should detect image media parts in the nested shape", () => {
    const nested = {
      type: "media",
      media: { source: { type: "base64", data: "AAAA", mediaType: "image/png" } },
    };
    expect(isMediaImagePart(nested)).toBe(true);
    expect(isMediaImagePart({ type: "text", text: "x" })).toBe(false);
    expect(
      isMediaImagePart({ type: "media", media: { source: { mediaType: "application/pdf" } } }),
    ).toBe(false);
  });
});

describe("transformV2Messages", () => {
  it("should replace image media parts on user messages with a pointer", () => {
    const dir = mkdtempSync(join(tmpdir(), "vr-test-"));
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "media", mediaType: "image/png", data: "AAAA" },
        ],
      },
    ];
    const out = transformV2Messages(msgs as any, "vision", dir) as any;
    expect(out[0].content.some((p: any) => p.type === "media")).toBe(false);
    expect(
      out[0].content.some(
        (p: any) => p.type === "text" && p.text.includes("saved at:"),
      ),
    ).toBe(true);
  });

  it("should leave other roles and non-array content untouched", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "media", mediaType: "image/png", data: "AAAA" }] },
      { role: "user", content: "just text" },
    ];
    const out = transformV2Messages(msgs as any, "vision") as any;
    expect(out[1].content).toBe("just text");
  });

  it("should strip data-URI image file parts embedded in tool results", () => {
    const msgs = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "t1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,AAAA" },
              ],
            },
          },
        ],
      },
    ];
    const out = transformV2Messages(msgs as any, "vision") as any;
    const value = out[0].content[0].result.value;
    expect(value.some((p: any) => p.type === "file")).toBe(false);
    expect(value.some((p: any) => p.type === "text" && p.text.includes("saved at:"))).toBe(true);
  });

  it("should strip image media parts from tool results too", () => {
    const msgs = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "t1",
            name: "render",
            result: {
              type: "content",
              value: [
                { type: "media", mediaType: "image/png", data: "AAAA" },
              ],
            },
          },
        ],
      },
    ];
    const out = transformV2Messages(msgs as any, "vision") as any;
    const value = out[0].content[0].result.value;
    expect(value.some((p: any) => p.type === "media")).toBe(false);
    expect(value.some((p: any) => p.type === "text" && p.text.includes("saved at:"))).toBe(true);
  });

  it("should leave non-image tool results untouched", () => {
    const msgs = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "t1",
            name: "shell",
            result: { type: "text", value: "ok" },
          },
        ],
      },
    ];
    const out = transformV2Messages(msgs as any, "vision") as any;
    expect(out[0].content[0]).toEqual(msgs[0].content[0]);
  });

  it("should not strip non-image file paths from tool results", () => {
    const msgs = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "t1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "file", uri: "/etc/passwd" },
                { type: "file", uri: "file:///tmp/notes.txt" },
                { type: "file", uri: "/tmp/report.pdf" },
              ],
            },
          },
        ],
      },
    ];
    const out = transformV2Messages(msgs as any, "vision") as any;
    const value = out[0].content[0].result.value;
    expect(value.every((p: any) => p.type === "file")).toBe(true);
    expect(value.map((p: any) => p.uri)).toEqual([
      "/etc/passwd",
      "file:///tmp/notes.txt",
      "/tmp/report.pdf",
    ]);
  });

  it("should strip image file paths by extension in tool results", () => {
    const msgs = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "t1",
            name: "read",
            result: {
              type: "content",
              value: [{ type: "file", uri: "file:///tmp/pic.png" }],
            },
          },
        ],
      },
    ];
    const out = transformV2Messages(msgs as any, "vision") as any;
    const value = out[0].content[0].result.value;
    expect(value.some((p: any) => p.type === "file")).toBe(false);
    expect(value[0].text).toContain("/tmp/pic.png");
  });

  it("should strip V2 user file parts that carry a uri instead of url", () => {
    const msgs = [
      {
        role: "user",
        content: [{ type: "file", uri: "data:image/png;base64,AAAA" }],
      },
    ];
    const out = transformV2Messages(msgs as any, "vision") as any;
    expect(out[0].content[0].type).toBe("text");
    expect(out[0].content[0].text).toContain("saved at:");
  });

  it("should keep non-image media (e.g. audio) untouched", () => {
    const msgs = [
      {
        role: "user",
        content: [{ type: "media", mediaType: "audio/wav", data: "AAAA" }],
      },
    ];
    const out = transformV2Messages(msgs as any, "vision") as any;
    expect(out[0].content[0].type).toBe("media");
  });
});

describe("OpenCode V2 agent injection", () => {
  it("should upsert the vision subagent with V2 fields", () => {
    const agents: any = {};
    applyAgent(
      { update: (id: string, update: (a: any) => void) => { const a: any = {}; update(a); agents[id] = a; } },
      { model: "opencode-go/qwen3.7-plus", agent: "vision" },
    );
    const agent = agents["vision"];
    expect(agent.mode).toBe("subagent");
    expect(agent.model).toEqual({ providerID: "opencode-go", id: "qwen3.7-plus" });
    expect(agent.system).toContain("vision analysis subagent");
    // V1/config object shape...
    expect(agent.permission).toEqual({
      external_directory: "allow",
      bash: "deny",
      edit: "deny",
      webfetch: "deny",
      doom_loop: "deny",
    });
    // ...and the V2 runtime Ruleset array, set together for cross-version support.
    expect(agent.permissions).toEqual([
      { action: "external_directory", resource: "*", effect: "allow" },
      { action: "bash", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "doom_loop", resource: "*", effect: "deny" },
    ]);
  });

  it("should keep nested slashes in the model ID (split on the first slash only)", () => {
    const agents: any = {};
    applyAgent(
      { update: (id: string, update: (a: any) => void) => { const a: any = {}; update(a); agents[id] = a; } },
      { model: "bifrost/vllm/zai/glm-5.3-flash", agent: "vision" },
    );
    expect(agents["vision"].model).toEqual({
      providerID: "bifrost",
      id: "vllm/zai/glm-5.3-flash",
    });
  });

  it("should be a no-op without a model", () => {
    const agents: any = {};
    applyAgent(
      { update: (id: string) => { agents[id] = {}; } },
      {},
    );
    expect(Object.keys(agents)).toHaveLength(0);
  });
});

describe("plugin V2 routing per model capability", () => {
  const imgContent = () => [
    { type: "text", text: "what is this?" },
    { type: "media", mediaType: "image/png", data: "AAAA" },
  ];

  const rows = [
    { providerID: "p", modelID: "multi", capabilities: { input: ["text", "image"] } },
    { providerID: "p", modelID: "text", capabilities: { input: ["text"] } },
    { providerID: "p", modelID: "legacy", capabilities: { input: { text: true, image: true } } },
    { providerID: "p", modelID: "attached", capabilities: { attachment: true } },
  ];

  // Load the V2 implementation with a fake ctx. `catalog` is the pre-rename
  // location (2.0.x); `model` is where newer 2.x releases expose the registry.
  const loadV2 = async (options: any, useCatalog = false) => {
    const hooks: Record<string, (event: any) => Promise<void>> = {};
    const ctx: any = {
      options,
      model: useCatalog ? undefined : { list: async () => ({ data: rows }) },
      catalog: useCatalog ? { model: { list: async () => ({ data: rows }) } } : undefined,
      agent: {
        transform: async (cb: any) => {
          cb({ update: () => {} });
          return { dispose: async () => {} };
        },
      },
      session: {
        hook: async (name: string, cb: any) => {
          hooks[name] = cb;
          return { dispose: async () => {} };
        },
      },
    };
    await (plugin as any).setup(ctx);
    return hooks.context!;
  };

  const turn = async (context: any, modelID: string, agent = "main") => {
    const event: any = {
      agent,
      model: { providerID: "p", id: modelID },
      messages: [{ role: "user", content: imgContent() }],
    };
    await context(event);
    return event;
  };

  const hasMedia = (event: any) =>
    event.messages[0].content.some((p: any) => p.type === "media");
  const hasPointer = (event: any) =>
    event.messages[0].content.some(
      (p: any) => p.type === "text" && p.text.includes("[The user attached an image"),
    );

  it("should skip routing when the main model is multimodal", async () => {
    const event = await turn(await loadV2({ model: "p/v" }), "multi");
    expect(hasMedia(event)).toBe(true);
    expect(hasPointer(event)).toBe(false);
  });

  it("should route when the main model is text-only", async () => {
    const event = await turn(await loadV2({ model: "p/v" }), "text");
    expect(hasMedia(event)).toBe(false);
    expect(hasPointer(event)).toBe(true);
  });

  it("should recognize legacy capability shapes (input.image, attachment)", async () => {
    expect(hasMedia(await turn(await loadV2({ model: "p/v" }), "legacy"))).toBe(true);
    expect(hasMedia(await turn(await loadV2({ model: "p/v" }), "attached"))).toBe(true);
  });

  it("should read the registry from catalog.model on older 2.x hosts", async () => {
    const event = await turn(await loadV2({ model: "p/v" }, true), "multi");
    expect(hasMedia(event)).toBe(true);
    expect(hasPointer(event)).toBe(false);
  });

  it("should route for unknown models (fail-open) and warn exactly once", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => void warnings.push(args.join(" "));
    let first, second;
    try {
      const context = await loadV2({ model: "p/v" });
      first = await turn(context, "mystery");
      second = await turn(context, "mystery");
    } finally {
      console.warn = origWarn;
    }
    expect(hasMedia(first!)).toBe(false);
    expect(hasMedia(second!)).toBe(false);
    expect(warnings.filter((w) => w.includes("not in registry"))).toHaveLength(1);
  });

  it("should route even on a multimodal main model when force is true", async () => {
    const event = await turn(await loadV2({ model: "p/v", force: true }), "multi");
    expect(hasMedia(event)).toBe(false);
    expect(hasPointer(event)).toBe(true);
  });

  it("should not rewrite the subagent's own messages", async () => {
    const event = await turn(await loadV2({ model: "p/v" }), "text", "vision");
    expect(hasMedia(event)).toBe(true);
  });
});

describe("dual V1/V2 default export", () => {
  it("should expose a V2 definition (id + setup) and a V1 server() function", () => {
    expect(typeof (plugin as any).id).toBe("string");
    expect((plugin as any).id).toBe("opencode-vision-router");
    expect(typeof (plugin as any).setup).toBe("function");
    expect(typeof (plugin as any).server).toBe("function");
  });
});
