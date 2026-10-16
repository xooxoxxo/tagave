import { describe, expect, it } from "vitest";
import { LinkError, MANIFEST_PATH, endpointsOf, manifestUrl, pinToOrigin, remoteOrigin, revokeUrlFor, type Manifest } from "../src/index.js";

const RG = "http://10.20.30.40:8080";

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    protocol: "music-connections/1",
    service: "review-gatherer",
    version: "0.4.0",
    auth: { authorize: "/connect/authorize", token: "/connect/token", register: "/connect/register" },
    provides: { "critic-scores": "/mc/v1/critic-scores", identity: "/mc/v1/identity", "wantlist-suggestions": "/mc/v1/wantlist-suggestions" },
    consumes: ["ratings", "collection", "listens", "identity"],
    ...over,
  };
}

describe("pinToOrigin", () => {
  it("a path or a same-origin URL resolves on the origin", () => {
    expect(pinToOrigin("/connect/token", RG, [])).toBe(`${RG}/connect/token`);
    expect(pinToOrigin(`${RG}/x`, RG, [])).toBe(`${RG}/x`);
  });

  it("refuses another host, another port and another scheme", () => {
    for (const u of ["http://10.20.30.41:8080/connect/token", "http://10.20.30.40:9090/connect/token", "https://10.20.30.40:8080/t", "//evil.example/t"]) {
      expect(() => pinToOrigin(u, RG, []), u).toThrow("endpoint on another host");
    }
  });

  it("an origin off the allow-list is refused even for its own paths", () => {
    expect(() => pinToOrigin("/x", "http://8.8.8.8", [])).toThrow("endpoint not allowed");
    expect(() => pinToOrigin("/x", "not an origin", [])).toThrow("endpoint invalid");
  });
});

describe("endpointsOf", () => {
  it("every feed in the manifest must sit on the origin, not only those a client reads", () => {
    expect(() => endpointsOf(manifest({ provides: { "critic-scores": "/a", ratings: "http://10.0.0.9/mc/v1/ratings" } }), RG, [])).toThrow("endpoint on another host");
    expect(() => endpointsOf(manifest({ auth: { authorize: "/a", token: "http://10.0.0.9/token", register: "/r" } }), RG, [])).toThrow(LinkError);
    const e = endpointsOf(manifest(), RG, []);
    expect(e.feeds["critic-scores"]).toBe(`${RG}/mc/v1/critic-scores`);
    expect(e).toMatchObject({ authorize: `${RG}/connect/authorize`, token: `${RG}/connect/token`, register: `${RG}/connect/register` });
  });
});

describe("remoteOrigin", () => {
  it("private hosts over http, names to be checked on resolution, public ones only when trusted", () => {
    expect(remoteOrigin(`${RG}/some/page?x=1`, [])).toBe(RG);
    expect(remoteOrigin("http://100.101.102.103", [])).toBe("http://100.101.102.103");
    expect(remoteOrigin("  http://review-gatherer:3000  ", [])).toBe("http://review-gatherer:3000");
    expect(remoteOrigin("https://rg.example.com/", [])).toBe("https://rg.example.com");
    for (const u of ["http://localhost.", "http://rg.localhost", "http://rg.example.com.", "http://under_score.lan", "http://-bad.lan"]) {
      expect(() => remoteOrigin(u, []), u).toThrow(LinkError);
    }
    expect(() => remoteOrigin("http://user:pw@10.20.30.40", [])).toThrow("invalid url");
    expect(() => remoteOrigin("ftp://10.20.30.40", [])).toThrow("invalid url");
    expect(() => remoteOrigin("not a url", [])).toThrow("invalid url");
    expect(() => remoteOrigin("http://8.8.8.8", [])).toThrow("remote not allowed");
  });

  it("the manifest lives at the well-known path of the origin", () => {
    expect(manifestUrl(RG)).toBe(`${RG}${MANIFEST_PATH}`);
    expect(MANIFEST_PATH).toBe("/.well-known/music-connections");
  });
});

describe("revokeUrlFor", () => {
  it("sits next to the token endpoint, on the origin", () => {
    expect(revokeUrlFor("/api/v1/connect/token", RG, [])).toBe(`${RG}/api/v1/connect/revoke`);
    expect(revokeUrlFor("/api/auth/oauth2/token?x=1", RG, [])).toBe(`${RG}/api/auth/oauth2/revoke`);
    expect(revokeUrlFor("/oauth/exchange", RG, [])).toBeNull();
    expect(revokeUrlFor("http://10.0.0.9/token", RG, [])).toBeNull();
    expect(revokeUrlFor("/token", "http://8.8.8.8", [])).toBeNull();
  });
});
