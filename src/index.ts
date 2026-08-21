import type { Plugin } from "@opencode-ai/plugin";
import { applyConfig, delegationInstruction } from "./agent";
import { transformMessages } from "./transform";
import type { Msg, Opts } from "./types";

/**
 * opencode-vision-router
 *
 * A third-party opencode plugin that routes pasted images to a cheap vision model
 * so a text-only main agent can work from the vision model's text output.
 *
 * The plugin is self-contained: at load time it injects a vision subagent and marks
 * the chosen model as image-capable, then uses the experimental chat-transform hooks
 * to strip images from the main agent's context and instruct it to delegate.
 */
const plugin: Plugin = async (_input, options) => {
  const opts = (options ?? {}) as Opts;
  const agentName = opts.agent || "vision";
  const tmpDir = opts.tmpDir;
  const enabled = !!opts.model;

  if (!enabled) {
    console.warn(
      "[opencode-vision-router] no `model` option set; vision routing disabled.",
    );
  }

  return {
    // Inject the vision subagent + declare the model image-capable at load time.
    config: async (cfg) => {
      if (!enabled) return;
      applyConfig(cfg as any, opts);
    },

    // Tell the main agent to delegate image pointers to the subagent.
    "experimental.chat.system.transform": async (_input, output) => {
      if (!enabled) return;
      output.system = output.system || [];
      output.system.push(delegationInstruction(agentName));
    },

    // Core fix: strip the image before the text-only model sees it, leave a path pointer.
    // NOTE: mutate `output.messages` IN PLACE (splice). Reassigning `output.messages`
    // (e.g. `output.messages = ...`) is a silent no-op in opencode (see issue #25754).
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!enabled) return;
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
