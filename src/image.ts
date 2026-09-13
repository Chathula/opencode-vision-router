import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FilePartLike, MediaPartLike } from "./types";

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

/** Persist decoded image bytes to a stable temp path and return it. */
function writeDecoded(
  decoded: { mime: string; buffer: Buffer },
  tmpDir: string,
): string {
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
    if (decoded) return writeDecoded(decoded, tmpDir);
    if (url.startsWith("file://")) return decodeURIComponent(url.slice(7));
    if (url.startsWith("/")) return url;
  } catch {
    return null;
  }
  return part?.filename || null;
}

/**
 * Resolve an OpenCode V2 `MediaPart` (image) to a readable path. V2 carries raw
 * image bytes (`data`: base64 string or Uint8Array) instead of a `url`, so the
 * bytes are materialized to a temp file. If the part's metadata names an
 * original file or URI, that location is preferred. Returns `null` when no
 * path can be resolved.
 */
export function resolveMediaPath(
  part: MediaPartLike,
  tmpDir: string = tmpdir(),
): string | null {
  try {
    const meta = part?.metadata;
    if (meta && typeof meta === "object") {
      for (const value of Object.values(meta)) {
        if (typeof value !== "string" || !value) continue;
        const decoded = decodeDataUrl(value);
        if (decoded) return writeDecoded(decoded, tmpDir);
        if (value.startsWith("file://")) return decodeURIComponent(value.slice(7));
        if (value.startsWith("/")) return value;
      }
    }
    const mime = part?.mediaType || "image/png";
    const data = part?.data;
    if (typeof data === "string" && data.length > 0) {
      return writeDecoded({ mime, buffer: Buffer.from(data, "base64") }, tmpDir);
    }
    if (data instanceof Uint8Array && data.length > 0) {
      return writeDecoded({ mime, buffer: Buffer.from(data) }, tmpDir);
    }
  } catch {
    return null;
  }
  return part?.filename || null;
}
