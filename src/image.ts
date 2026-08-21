import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FilePartLike } from "./types";

/** Pick a file extension from a MIME type. */
export function extForMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("webp")) return "webp";
  return "bin";
}

/** Decode a `data:` URL into `{ mime, buffer }`, or null if it is not a base64 data URL. */
export function decodeDataUrl(
  url: string,
): { mime: string; buffer: Buffer } | null {
  const m = url.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) return null;
  return { mime: m[1], buffer: Buffer.from(m[2], "base64") };
}

/**
 * Resolve an opencode image `FilePart` to a path a text-only model's subagent can
 * `read`. Pasted images arrive as `data:` URLs; decode them to a temp file so the
 * main (text-only) model never touches the bytes. `file://` and absolute paths are
 * returned as-is. Returns `null` if the part cannot be resolved.
 */
export function resolveImagePath(
  part: FilePartLike,
  tmpDir: string = tmpdir(),
): string | null {
  const url = part?.url || "";
  try {
    const decoded = decodeDataUrl(url);
    if (decoded) {
      const ext = extForMime(decoded.mime);
      const name =
        "opencode-vision-" +
        createHash("sha1").update(decoded.buffer).digest("hex").slice(0, 16) +
        "." +
        ext;
      const dir = join(tmpDir, "opencode-vision");
      mkdirSync(dir, { recursive: true });
      const p = join(dir, name);
      if (!existsSync(p)) writeFileSync(p, decoded.buffer);
      return p;
    }
    if (url.startsWith("file://")) return decodeURIComponent(url.slice(7));
    if (url.startsWith("/")) return url;
  } catch {
    return null;
  }
  return part?.filename || null;
}
