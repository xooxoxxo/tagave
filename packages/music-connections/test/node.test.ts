/**
 * The pinned transport. No live network: names are answered by a test
 * resolver, and the one real socket is a loopback server this file starts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LinkError, readCapped } from "../src/index.js";
import { pinnedFetch, pinnedLookup, resolveTarget, type Resolver, type Transport } from "../src/node/index.js";

const noDns: Resolver = async (h) => { throw new Error(`no live DNS in tests (${h})`); };
const UA = "test/1 (music-connections/1)";

describe("resolveTarget", () => {
  it("a LAN name may reach private addresses only", async () => {
    const answers: Record<string, string[]> = {
      "review-gatherer": ["10.20.30.40"],
      "sneaky.lan": ["127.0.0.1"],
      "mixed.lan": ["10.20.30.40", "93.184.216.34"],
      "public.example.com": ["93.184.216.34"],
      "meta.lan": ["169.254.169.254"],
    };
    const r: Resolver = async (h) => answers[h] ?? [];
    await expect(resolveTarget("http://review-gatherer:3000/.well-known/music-connections", [], r)).resolves.toBe("10.20.30.40");
    await expect(resolveTarget("http://sneaky.lan/", [], r)).rejects.toThrow("address not allowed");
    await expect(resolveTarget("http://mixed.lan/", [], r)).rejects.toThrow("address not allowed");
    await expect(resolveTarget("https://public.example.com/", [], r)).rejects.toThrow("address not allowed");
    await expect(resolveTarget("http://meta.lan/", [], r)).rejects.toThrow("address not allowed");
    await expect(resolveTarget("https://public.example.com/", ["public.example.com"], r)).resolves.toBe("93.184.216.34");
    await expect(resolveTarget("http://public.example.com/", ["public.example.com"], r)).rejects.toThrow("address not allowed");
    await expect(resolveTarget("http://nothing.lan/", [], r)).rejects.toThrow("remote unresolvable");
  });

  it("a trusted name is resolved on every request and each answer checked (DNS rebinding)", async () => {
    const answers = [["93.184.216.34"], ["169.254.169.254"], ["93.184.216.34", "127.0.0.1"], ["::ffff:10.0.0.1"], []];
    const asked: string[] = [];
    const r: Resolver = async (h) => { asked.push(h); return answers.shift()!; };
    const t = ["rg.example.com"];
    await expect(resolveTarget("https://rg.example.com/.well-known/music-connections", t, r)).resolves.toBe("93.184.216.34");
    await expect(resolveTarget("https://rg.example.com/connect/token", t, r)).rejects.toThrow("address not allowed");
    await expect(resolveTarget("https://rg.example.com/mc/v1/identity", t, r)).rejects.toThrow("address not allowed");
    await expect(resolveTarget("https://rg.example.com/x", t, r)).resolves.toBe("::ffff:10.0.0.1");
    await expect(resolveTarget("https://rg.example.com/x", t, r)).rejects.toThrow("remote unresolvable");
    expect(asked).toHaveLength(5);
  });

  it("a literal is never resolved; a failing resolver is unresolvable; a bad URL is invalid", async () => {
    await expect(resolveTarget("http://10.20.30.40/", [], noDns)).resolves.toBe("10.20.30.40");
    await expect(resolveTarget("http://lan.name/", [], noDns)).rejects.toThrow("remote unresolvable");
    await expect(resolveTarget("not a url", [], noDns)).rejects.toThrow("invalid url");
  });
});

describe("pinnedFetch", () => {
  it("every request is checked, also with a test transport in place", async () => {
    const reached: string[] = [];
    const transport: Transport = async (url) => { reached.push(url); return new Response("{}"); };
    for (const u of ["http://169.254.169.254/latest/meta-data", "http://[::ffff:a9fe:a9fe]/", "http://0.0.0.0:8080/", "http://8.8.8.8/"]) {
      await expect(pinnedFetch(u, {}, { trustedPublicHosts: [], userAgent: UA, transport, resolver: noDns })).rejects.toThrow("remote not allowed");
    }
    expect(reached).toEqual([]);
  });

  it("sends the user agent, no redirects and a timeout, to the checked address", async () => {
    const seen: Array<{ url: string; init: RequestInit; address: string }> = [];
    const transport: Transport = async (url, init, address) => { seen.push({ url, init, address }); return new Response("{}"); };
    await pinnedFetch("http://review-gatherer:3000/x", { headers: { accept: "application/json" } }, {
      trustedPublicHosts: [], userAgent: UA, transport, resolver: async () => ["10.20.30.40"],
    });
    expect(seen[0]!.address).toBe("10.20.30.40");
    expect(seen[0]!.init.redirect).toBe("manual");
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.init.headers).toEqual({ accept: "application/json", "user-agent": UA });
  });

  it("a 3xx answer is an error, never followed", async () => {
    const transport: Transport = async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    await expect(pinnedFetch("http://10.20.30.40/", {}, { trustedPublicHosts: [], userAgent: UA, transport })).rejects.toThrow("redirect refused");
  });
});

describe("pinnedLookup", () => {
  it("answers any name with the checked address", () => {
    const lookup = pinnedLookup("10.20.30.40") as unknown as (h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void;
    const one: unknown[] = [];
    lookup("evil.example", {}, (...a) => one.push(...a));
    expect(one).toEqual([null, "10.20.30.40", 4]);
    const all: unknown[] = [];
    lookup("evil.example", { all: true }, (...a) => all.push(...a));
    expect(all).toEqual([null, [{ address: "10.20.30.40", family: 4 }]]);
    const v6: unknown[] = [];
    (pinnedLookup("fd12::1") as unknown as (h: string, cb: (...a: unknown[]) => void) => void)("x", (...a) => v6.push(...a));
    expect(v6).toEqual([null, "fd12::1", 6]);
  });
});

describe("over a real loopback socket", () => {
  let server: Server;
  let port = 0;
  const seen: Array<{ url: string; host: string | undefined; ua: string | undefined }> = [];
  const opts = { trustedPublicHosts: [] as string[], userAgent: UA, resolver: noDns };

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", host: req.headers.host, ua: req.headers["user-agent"] });
      if (req.url === "/redirect") { res.writeHead(301, { location: "http://169.254.169.254/" }); res.end(); return; }
      if (req.url === "/big") { res.writeHead(200); res.end("x".repeat(100_000)); return; }
      if (req.url === "/slow") { setTimeout(() => res.end("{}"), 500); return; }
      if (req.url === "/broken") { res.writeHead(200, { "content-length": "1000" }); res.write("{\"pro"); setTimeout(() => res.destroy(), 20); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, method: req.method }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("reaches a literal loopback host on the port the URL names, Host header kept", async () => {
    const res = await pinnedFetch(`http://127.0.0.1:${port}/ping?x=1`, { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } }, opts);
    expect(await res.json()).toEqual({ ok: true, method: "POST" });
    expect(seen.at(-1)).toEqual({ url: "/ping?x=1", host: `127.0.0.1:${port}`, ua: UA });
    const viaName = await pinnedFetch(`http://localhost:${port}/ping`, {}, { ...opts, resolver: async () => ["127.0.0.1"] });
    expect(viaName.status).toBe(200);
    expect(seen.at(-1)!.host).toBe(`localhost:${port}`);
  });

  it("refuses a redirect, caps a body and times out", async () => {
    await expect(pinnedFetch(`http://127.0.0.1:${port}/redirect`, {}, opts)).rejects.toThrow("redirect refused");
    const big = await pinnedFetch(`http://127.0.0.1:${port}/big`, {}, opts);
    await expect(readCapped(big, 64 * 1024)).rejects.toThrow("response too large");
    await expect(pinnedFetch(`http://127.0.0.1:${port}/slow`, {}, { ...opts, timeoutMs: 50 })).rejects.toThrow();
  });

  it("a body that breaks off after the headers is a LinkError", async () => {
    const res = await pinnedFetch(`http://127.0.0.1:${port}/broken`, {}, opts);
    await expect(readCapped(res, 64 * 1024)).rejects.toBeInstanceOf(LinkError);
  });
});
