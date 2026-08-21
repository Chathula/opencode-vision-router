import type { Plugin } from "@opencode-ai/plugin";
import { applyConfig } from "./agent";
import { transformMessages, isImagePart, imagePointer } from "./transform";
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
 */

const plugin: Plugin = async (_input, options) => {
  const opts = (options ?? {}) as Opts;
  const agentName = opts.agent || "vision";
  const tmpDir = opts.tmpDir;
  const hasModel = !!opts.model;
  const force = !!opts.force;

  // modelID -> image-capable, learned from `chat.params` (full Model capabilities).
  // `chat.message` runs before `chat.params` in a turn, so the very first message
  // for a given model (before its capability is known) defaults to routing. After
  // that the decision is exact and updates immediately on a mid-session switch.
  const capabilities = new Map<string, boolean>();
  let routeEnabled = hasModel;

  if (!hasModel) {
    console.warn(
      "[opencode-vision-router] no `model` option set; vision routing disabled.",
    );
  }

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

export default plugin;
