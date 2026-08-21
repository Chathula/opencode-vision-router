import type { Config } from "@opencode-ai/plugin";
import type { Opts } from "./types";

/** Build the config object for the injected vision subagent. */
export function buildVisionAgentConfig(opts: Opts): Record<string, any> {
  const agentName = opts.agent || "vision";
  return {
    description:
      "Vision analysis subagent. Reads an image path and returns a textual description.",
    mode: "subagent",
    model: opts.model,
    prompt:
      "You are a vision analysis subagent. You are given an image FILE PATH and a question. " +
      "Use the read tool on the path to load the image, analyze it, and return ONLY the textual analysis.",
    permission: {
      external_directory: "allow",
      bash: "deny",
      edit: "deny",
      webfetch: "deny",
      doom_loop: "deny",
    },
  } as Record<string, any>;
}

/**
 * Mutate an opencode `Config` to (a) declare the chosen model as image-capable and
 * (b) inject the vision subagent. No-op if `opts.model` is missing or malformed.
 */
export function applyConfig(cfg: Config, opts: Opts): void {
  const model = opts.model;
  if (!model) return;
  const [provider, modelId] = model.split("/");
  if (!provider || !modelId) return;

  cfg.provider = cfg.provider || {};
  cfg.provider[provider] = cfg.provider[provider] || { models: {} };
  cfg.provider[provider].models = cfg.provider[provider].models || {};
  cfg.provider[provider].models[modelId] = {
    ...(cfg.provider[provider].models[modelId] || {}),
    id: modelId,
    modalities: { input: ["text", "image"], output: ["text"] },
    attachment: true,
  };

  cfg.agent = cfg.agent || {};
  cfg.agent[opts.agent || "vision"] = buildVisionAgentConfig(opts) as any;
}

/** The system instruction telling the main agent to delegate image pointers. */
export function delegationInstruction(agentName: string): string {
  return (
    `If a user message contains an image pointer like '[image saved at: PATH]', ` +
    `delegate analysis to the "${agentName}" subagent via the Task tool, passing the path and the user's request.`
  );
}
