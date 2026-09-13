import { Plugin } from "@opencode/plugin";
import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import { applyAgent, applyConfig } from "./agent";
import {
  isImagePart,
  imagePointer,
  transformMessages,
  transformV2Messages,
} from "./transform";
import { resolveImagePath } from "./image";
import type { Msg, Opts } from "./types";

/**
 * opencode-vision-router
 *
 * A third-party opencode plugin that routes pasted images to a cheap vision model
 * so a text-only main agent can work from the vision model's text output.
 *
 * At load time it injects a vision subagent, then rewrites image parts of the
 * main agent's messages into text pointers that instruct it to delegate analysis
 * to that subagent.
 *
 * If the *main* model is already multimodal, routing is skipped by default (the
 * main model sees the image directly). Set `force: true` to always route — e.g.
 * to send images to a cheaper vision model while keeping a stronger text model
 * as main.
 *
 * The default export supports both OpenCode V1 and V2:
 * - V1 (>= 1.18.29) calls `server(input, options)` and uses the returned hooks.
 * - V2 validates the export's `id` + `setup()` and runs the V2 implementation.
 */

const PLUGIN_ID = "opencode-vision-router";

/** Shared option parsing + the image-pointer instruction. */
function parseOptions(options: Record<string, unknown> | undefined) {
  const opts = (options ?? {}) as Opts;
  return {
    opts,
    agentName: opts.agent || "vision",
    tmpDir: opts.tmpDir,
    hasModel: !!opts.model,
    force: !!opts.force,
  };
}

const NO_MODEL_WARNING =
  "[opencode-vision-router] no `model` option set; vision routing disabled.";

// ---------------------------------------------------------------------------
// V1 implementation (unchanged behavior)
// ---------------------------------------------------------------------------

const v1Plugin: V1Plugin = async (_input, options) => {
  const { opts, agentName, tmpDir, hasModel, force } = parseOptions(options);

  // modelID -> image-capable, learned from `chat.params` (full Model capabilities).
  // `chat.message` runs before `chat.params` in a turn, so the very first message
  // for a given model (before its capability is known) defaults to routing. After
  // that the decision is exact and updates immediately on a mid-session switch.
  const capabilities = new Map<string, boolean>();
  let routeEnabled = hasModel;

  if (!hasModel) console.warn(NO_MODEL_WARNING);

  return {
    // Inject the vision subagent at load time.
    config: async (cfg) => {
      if (!hasModel) return;
      applyConfig(cfg as any, opts);
    },

    // Learn each model's image capability as requests are actually made.
    "chat.params": async (input) => {
      const id = (input as any)?.model?.id;
      const img = !!(input as any)?.model?.capabilities?.input?.image;
      if (id) capabilities.set(id, img);
    },

    // Runs first per user message and owns the rewrite, so the stripped message is
    // what the model sees this turn (detection hooks run too late to be authoritative).
    "chat.message": async (input, output) => {
      if (!hasModel) return;
      if ((input as any)?.agent === agentName) return; // never rewrite the subagent
      const id = (input as any)?.model?.modelID;
      const isMultimodal = id ? capabilities.get(id) : undefined;
      // Route unless we know the model is multimodal (or `force` is set).
      const route = force || isMultimodal !== true;
      routeEnabled = route;
      if (!route) return;
      const parts = ((output as any).parts as any[]) || [];
      (output as any).parts = parts.map((p: any) => {
        if (isImagePart(p)) {
          const path = resolveImagePath(p, tmpDir);
          if (path) return { type: "text", text: imagePointer(path, agentName) };
        }
        return p;
      });
    },

    // Idempotent backup transform (primary rewrite happens in `chat.message`).
    "experimental.chat.messages.transform": async (_input2, output) => {
      if (!routeEnabled) return;
      const transformed = transformMessages(
        output.messages as unknown as Msg[],
        agentName,
        tmpDir,
      );
      output.messages.splice(0, output.messages.length, ...(transformed as any));
    },
  };
};

// ---------------------------------------------------------------------------
// V2 implementation
// ---------------------------------------------------------------------------

const v2Plugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const { opts, agentName, tmpDir, hasModel, force } = parseOptions(
      ctx.options as Record<string, unknown> | undefined,
    );

    if (!hasModel) console.warn(NO_MODEL_WARNING);

    // modelID -> image-capable, learned from the model catalog on first use and
    // memoized per provider/model. Unknown models default to routing, matching
    // the V1 behavior before a model's capability is known.
    const capabilities = new Map<string, boolean>();
    const isImageCapable = async (providerID: string, modelID: string) => {
      const key = `${providerID}/${modelID}`;
      const cached = capabilities.get(key);
      if (cached !== undefined) return cached;
      try {
        const { data } = await ctx.catalog.model.list();
        const model = (data as any[]).find(
          (m) => m.providerID === providerID && (m.modelID ?? m.id) === modelID,
        );
        const img =
          Array.isArray(model?.capabilities?.input) &&
          model.capabilities.input.includes("image");
        capabilities.set(key, img);
        return img;
      } catch {
        return false;
      }
    };

    if (hasModel) {
      // Inject the vision subagent (agent.update upserts missing agents).
      await ctx.agent.transform((editor) => {
        applyAgent(editor as any, opts);
      });
    }

    // Rewrite image media parts on user messages immediately before each
    // agent-loop model request. This covers both fresh attachments and image
    // parts already in history (the equivalent of V1's chat.message +
    // experimental.chat.messages.transform). Capability comes from the model
    // catalog, so no learning hooks are needed.
    await ctx.session.hook("context", async (event) => {
      if (!hasModel) return;
      if (event.agent === agentName) return; // never rewrite the subagent
      const isMultimodal = await isImageCapable(
        event.model.providerID,
        event.model.id,
      );
      if (!force && isMultimodal) return;
      (event as any).messages = transformV2Messages(
        event.messages as any[],
        agentName,
        tmpDir,
      );
    });
  },
});

// ---------------------------------------------------------------------------
// Dual V1/V2 default export
// ---------------------------------------------------------------------------

export default {
  ...v2Plugin,
  async server(input: unknown, options?: Record<string, unknown>) {
    return v1Plugin(input as any, options);
  },
};
