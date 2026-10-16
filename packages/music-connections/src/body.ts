import { LinkError, networkReason } from "./errors.js";

/**
 * A response body read incrementally and refused past `max` bytes, by its
 * declared length or by what arrives. A body that breaks off after the
 * headers (reset, timeout) is a LinkError too, never an unexpected error.
 * Throws LinkError ('response too large', or networkReason's reason with 'response unreadable' as the fallback).
 */
export async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new LinkError("response too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    let step: Awaited<ReturnType<typeof reader.read>>;
    try {
      step = await reader.read();
    } catch (err) {
      throw new LinkError(networkReason(err, "response unreadable"));
    }
    const { done, value } = step;
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new LinkError("response too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
