export type Opts = {
  /** Vision-capable model as `provider/model`, e.g. `opencode-go/qwen3.7-plus`. */
  model?: string;
  /** Name of the injected vision subagent. Defaults to `vision`. */
  agent?: string;
  /** Directory under which decoded images are cached. Defaults to `os.tmpdir()`. */
  tmpDir?: string;
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
