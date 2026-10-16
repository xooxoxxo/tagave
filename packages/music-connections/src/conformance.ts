import { ManifestSchema, FeedPageSchema, CAPABILITY_DATA } from "./schemas.js";
import type { Capability } from "./capabilities.js";

export async function runConformance(opts: { baseUrl: string; token: string; fetch?: typeof fetch }): Promise<{ ok: boolean; failures: string[]; notes: string[] }> {
  const f = opts.fetch ?? fetch;
  const failures: string[] = [];
  const notes: string[] = [];
  const MAX_PAGES = 50;
  const url = (p: string) => new URL(p, opts.baseUrl);
  const get = (p: string | URL, token?: string) => f(url(String(p)), { headers: token ? { authorization: `Bearer ${token}` } : {} });

  const mres = await get("/.well-known/music-connections");
  const manifest = ManifestSchema.safeParse(await mres.json().catch(() => null));
  if (!mres.ok || !manifest.success) return { ok: false, failures: ["manifest missing or invalid"], notes };

  for (const [cap, path] of Object.entries(manifest.data.provides) as [Capability, string][]) {
    const anon = await get(path);
    if (anon.status !== 401) failures.push(`${cap}: expected 401 without token, got ${anon.status}`);

    const bad = await get(`${path}?since=%%%garbage`, opts.token);
    if (bad.status !== 400) failures.push(`${cap}: expected 400 for an invalid cursor, got ${bad.status}`);

    const schema = await get(`/mc/v1/schema/${cap}.json`);
    const sbody: unknown = schema.status === 200 ? await schema.json().catch(() => null) : null;
    const sobj = sbody as Record<string, unknown> | null;
    if (!sobj || typeof sobj !== "object" || Array.isArray(sobj) || !(sobj.type === "object" || "properties" in sobj))
      failures.push(`${cap}: schema endpoint missing or not a JSON Schema object (HTTP ${schema.status})`);

    const envelope = FeedPageSchema(CAPABILITY_DATA[cap]);
    let since = "", pages = 0;
    for (;;) {
      if (++pages > MAX_PAGES) { notes.push(`${cap}: stopped after ${MAX_PAGES} pages with more data still advancing`); break; }
      const u = url(path); u.searchParams.set("limit", "500"); if (since) u.searchParams.set("since", since);
      const res = await get(u, opts.token);
      const body = envelope.safeParse(await res.json().catch(() => null));
      if (!res.ok || !body.success) { failures.push(`${cap}: invalid page (HTTP ${res.status})`); break; }
      if (!body.data.more) break;
      if (body.data.next === since) { failures.push(`${cap}: next cursor did not advance`); break; }
      since = body.data.next;
    }
  }
  return { ok: failures.length === 0, failures, notes };
}
