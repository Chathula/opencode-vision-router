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
 *
 * If the *main* model is already multimodal, routing is skipped by default (the main
 * model sees the image directly). Set `force: true` to always route — e.g. to send
 * images to a cheaper vision model while keeping a stronger text model as main.
 */

/** Best-effort check of whether the configured main model accepts images. */
function mainModelIsMultimodal(cfg: any): boolean | null {
  const ref = typeof cfg?.model === "string" ? cfg.model : undefined;
  if (!ref) return null;
  const [provider, modelId] = ref.includes("/")
    ? ref.split("/")
    : [undefined, ref];
  const providers = cfg?.provider || {};
  const prov = provider ? providers[provider] : Object.values(providers)[0];
  const input = prov?.models?.[modelId]?.modalities?.input;
  if (!Array.isArray(input)) return null;
  return input.includes("image");
}

const plugin: Plugin = async (_input, options) => {
  const opts = (options ?? {}) as Opts;
  const agentName = opts.agent || "vision";
  const tmpDir = opts.tmpDir;
  const hasModel = !!opts.model;
  const force = !!opts.force;

  // Refined per-message (see experimental.chat.system.transform), but seeded
  // here from the config so the very first message is correct when detectable.
  let routeEnabled = hasModel;
  let skipLogged = false;

  if (!hasModel) {
    console.warn(
      "[opencode-vision-router] no `model` option set; vision routing disabled.",
    );
  }

  const noteSkip = () => {
    if (skipLogged) return;
    skipLogged = true;
    console.log(
      "[opencode-vision-router] main model is multimodal; skipping vision " +
        "subagent. Set `force: true` to route images to a (cheaper) vision model anyway.",
    );
  };

  return {
    // Inject the vision subagent + declare the model image-capable at load time.
    config: async (cfg) => {
      if (!hasModel) return;
      const mm = mainModelIsMultimodal(cfg);
      if (mm === true && !force) {
        routeEnabled = false;
        noteSkip();
      } else if (mm === false) {
        routeEnabled = true;
      }
      applyConfig(cfg as any, opts);
    },

    // Tell the main agent to delegate image pointers to the subagent.
    "experimental.chat.system.transform": async (input, output) => {
      if (!hasModel) return;
      // Authoritative, per-message: read the active model's capabilities.
      const mm = (input as any)?.model?.modalities?.input?.includes("image");
      if (mm === true && !force) {
        routeEnabled = false;
        noteSkip();
      } else if (mm === false || force) {
        routeEnabled = true;
      }
      if (!routeEnabled) return;
      output.system = output.system || [];
      output.system.push(delegationInstruction(agentName));
    },

    // Core behavior: strip the image before the model sees it, leave a path pointer.
    // NOTE: mutate `output.messages` IN PLACE (splice). Reassigning `output.messages`
    // (e.g. `output.messages = ...`) is a silent no-op in opencode (see issue #25754).
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
