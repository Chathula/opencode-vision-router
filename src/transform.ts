import { resolveImagePath } from "./image";
import type { FilePartLike, Msg } from "./types";

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

function isImagePart(part: any): part is FilePartLike {
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
