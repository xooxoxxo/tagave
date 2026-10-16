/**
 * Masks secrets in text before it goes into a run (its log, reason, stall,
 * sub-state), which is saved in state.json and shown on Settings › Updates.
 * Container logs and command output can carry a database URL with its
 * password, an Authorization header or a key in KEY=value form.
 *
 * Image digests (sha256:…) stay readable: they are the point of the log.
 */

const MASK = '***';

type Rule = [RegExp, (match: string, ...groups: string[]) => string];

const RULES: Rule[] = [
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi, (_m, head) => `${head}${MASK}@`],
  // Authorization: <scheme> <credentials>
  [/\b(authorization\s*[:=]\s*)(?:(basic|bearer|token|digest)\s+)?[^\s,;"']+/gi, (_m, head, scheme) => `${head}${scheme ? `${scheme} ` : ''}${MASK}`],
  // a bearer token anywhere else
  [/\b(bearer\s+)(?!\*\*\*)[\w.~+/=-]{8,}/gi, (_m, head) => `${head}${MASK}`],
  // password=…, PGPASSWORD=…, APP_SECRET=…, api_key: …, "token": "…"
  [/\b([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|key))(["']?\s*[=:]\s*["']?)(?!\*\*\*)[^\s"'&,;)\]}]+/gi, (_m, name, sep) => `${name}${sep}${MASK}`],
  // a long run of hex (an APP_SECRET), unless it is a digest
  [/(?<![0-9a-f:])[0-9a-f]{40,}(?![0-9a-f])/gi, () => MASK],
  // a long token-like run: upper and lower case and digits, no slash
  [/(?<![\w+/-])(?=[\w+-]*[A-Z])(?=[\w+-]*[a-z])(?=[\w+-]*\d)[\w+-]{40,}={0,2}(?![\w+/-])/g, () => MASK],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to as (substring: string, ...args: string[]) => string);
  return out;
}
