export class CursorError extends Error {}
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_CURSOR_LEN = 512;
export function encodeCursor(c: { t: string; id: string }): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}
export function decodeCursor(s: string): { t: string; id: string } {
  if (typeof s !== "string" || s.length > MAX_CURSOR_LEN) throw new CursorError("invalid cursor");
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (
      typeof v?.t !== "string" || !ISO_UTC.test(v.t) || Number.isNaN(Date.parse(v.t)) ||
      typeof v?.id !== "string" || !ID.test(v.id)
    ) throw new Error();
    return { t: v.t, id: v.id };
  } catch {
    throw new CursorError("invalid cursor");
  }
}
