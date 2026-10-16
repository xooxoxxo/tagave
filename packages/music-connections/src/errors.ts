/**
 * Errors whose message is safe to log and to store as a link's last error:
 * always one of a fixed set of short strings, never a token, a secret, a URL
 * the remote chose or a remote's body.
 */
export class LinkError extends Error {
  override name = "LinkError";
}

/** A fixed, log-safe reason for a failed request: a LinkError's own, timeout, network, or `fallback`. */
export function networkReason(err: unknown, fallback: string): string {
  if (err instanceof LinkError) return err.message;
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "remote timed out";
    if (err.name === "TypeError") return "remote unreachable";
  }
  return fallback;
}
