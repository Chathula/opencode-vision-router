export type Opts = {
  /** Vision-capable model as `provider/model`, e.g. `opencode-go/qwen3.7-plus`. */
  model?: string;
  /** Name of the injected vision subagent. Defaults to `vision`. */
  agent?: string;
  /** Directory under which decoded images are cached. Defaults to `os.tmpdir()`. */
  tmpDir?: string;
  /**
   * Route images to the vision subagent even when the main model is itself
   * multimodal. Default: `false` (auto-skip — if the main model can see images,
   * the subagent is not used, so the main model handles images directly). Set to
   * `true` to always route, e.g. to offload images to a cheaper vision model.
   */
  force?: boolean;
};

export interface FilePartLike {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
}

export interface Msg {
  info?: { role?: string };
  parts: any[];
}
