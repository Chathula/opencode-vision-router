import { resolveImagePath, resolveMediaPath } from "./image";
import type { FilePartLike, MediaPartLike, Msg } from "./types";

const IMAGE_PREFIX = "[The user attached an image, saved at:";
const IMAGE_SUFFIX = "]";

/** Build the text pointer that replaces an image file part. */
export function imagePointer(path: string, agentName: string): string {
  return (
    `${IMAGE_PREFIX} ${path}${IMAGE_SUFFIX}\n` +
    `Use the "${agentName}" subagent (via the Task tool) to analyze this image ` +
    `and answer the user's request about it. Pass the path and the request to the subagent.`
  );
}

 export function isImagePart(part: any): part is FilePartLike {
   return part?.type === "file" && typeof part.mime === "string" && part.mime.startsWith("image/");
 }

/**
 * Pure transform: replace image file parts on **user** messages with a text pointer
 * containing the resolved image path. Other messages (and assistant messages) are
 * returned unchanged. Returns a new message array; the input is not mutated.
 */
export function transformMessages(
  messages: Msg[],
  agentName: string,
  tmpDir?: string,
): Msg[] {
  return messages.map((msg) => {
    const parts: any[] = msg?.parts || [];
    const hasImage = parts.some(isImagePart);
    if (!hasImage) return msg;
    if (msg.info?.role && msg.info.role !== "user") return msg;

    let replaced = false;
    const newParts = parts.map((part) => {
      if (isImagePart(part)) {
        const path = resolveImagePath(part, tmpDir);
        if (path) {
          replaced = true;
          return { type: "text", text: imagePointer(path, agentName) };
        }
      }
      return part;
    });

    return replaced ? { ...msg, parts: newParts } : msg;
  });
}

/** OpenCode V2 message: `role` plus a `content` array of parts. */
export interface V2Msg {
  role?: string;
  content?: unknown;
}

/** V2 media part carrying image bytes. */
export function isMediaImagePart(part: any): part is MediaPartLike {
  return (
    part?.type === "media" &&
    typeof part.mediaType === "string" &&
    part.mediaType.startsWith("image/")
  );
}

/**
 * V2 variant of `transformMessages`: OpenCode V2 messages use `role` + a
 * `content` array, and images arrive as `media` parts carrying raw bytes.
 * Replace image media parts on user messages with the text pointer. Returns a
 * new message array; the input is not mutated.
 */
export function transformV2Messages(
  messages: V2Msg[],
  agentName: string,
  tmpDir?: string,
): V2Msg[] {
  return messages.map((msg) => {
    if (msg?.role && msg.role !== "user") return msg;
    const parts = msg?.content;
    if (!Array.isArray(parts)) return msg;
    const hasImage = (parts as any[]).some(isMediaImagePart);
    if (!hasImage) return msg;

    let replaced = false;
    const newParts = (parts as any[]).map((part) => {
      if (isMediaImagePart(part)) {
        const path = resolveMediaPath(part, tmpDir);
        if (path) {
          replaced = true;
          return { type: "text", text: imagePointer(path, agentName) };
        }
      }
      return part;
    });

    return replaced ? { ...msg, content: newParts } : msg;
  });
}
