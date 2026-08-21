import { describe, it, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveImagePath, decodeDataUrl, extForMime } from "./image";
import { transformMessages, imagePointer } from "./transform";
import { applyConfig, buildVisionAgentConfig, delegationInstruction } from "./agent";
import type { Config } from "@opencode-ai/plugin";
import plugin from "./index";

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
    const hooks = (await plugin({} as any, { model: "p/v" })) as any;
    const out = await turn(hooks, "m", true);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(true); // image intact
  });

  it("should route when the main model is text-only", async () => {
    const hooks = (await plugin({} as any, { model: "p/v" })) as any;
    const out = await turn(hooks, "m", false);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(false); // stripped
    expect(
      out.parts.some(
        (p: any) => p.type === "text" && p.text.includes("[The user attached an image"),
      ),
    ).toBe(true); // pointer added
  });

  it("should route even on a multimodal main model when force is true", async () => {
    const hooks = (await plugin({} as any, { model: "p/v", force: true })) as any;
    const out = await turn(hooks, "m", true);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(false); // stripped
  });

  it("should switch routing when the model changes mid-session", async () => {
    const hooks = (await plugin({} as any, { model: "p/v" })) as any;
    let out = await turn(hooks, "multi", true);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(true); // multimodal: skip
    out = await turn(hooks, "text", false);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(false); // text-only: route
    out = await turn(hooks, "multi", true);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(true); // back to multimodal: skip
  });

  it("should disable routing entirely without a model", async () => {
    const hooks = (await plugin({} as any, {})) as any;
    const out: any = { parts: imgParts() };
    await hooks["chat.message"]({ model: { modelID: "m" } }, out);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(true); // untouched
  });

  it("should not rewrite the subagent's own messages", async () => {
    const hooks = (await plugin({} as any, { model: "p/v" })) as any;
    await hooks["chat.params"]({
      model: { id: "multi", capabilities: { input: { image: true }, output: {} } },
    });
    const out: any = { parts: imgParts() };
    await hooks["chat.message"]({ model: { modelID: "multi" }, agent: "vision" }, out);
    expect(out.parts.some((p: any) => p.type === "file")).toBe(true); // untouched
  });
});
