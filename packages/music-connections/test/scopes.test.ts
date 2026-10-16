import { describe, expect, it } from "vitest";
import {
  OFFLINE_ACCESS, WANTLIST_WRITE, availableUngranted, capabilityScopes, linkScopes, parseScopeRequest, providerScopes, pullableCapabilities,
  sharedCapabilities, type Capability, type Manifest,
} from "../src/index.js";

// what a library offers (ratings, collection, listens, identity) and what a review service offers
const LIBRARY = providerScopes(["ratings", "collection", "listens", "identity"]);
const REVIEWS = providerScopes(["critic-scores", "identity", "wantlist-suggestions"]);

describe("providerScopes", () => {
  it("one read scope per provided capability, the wantlist write scope only with wantlist suggestions", () => {
    expect(LIBRARY).toEqual(["ratings:read", "collection:read", "listens:read", "identity:read"]);
    expect(REVIEWS).toEqual(["critic-scores:read", "identity:read", "wantlist-suggestions:read", WANTLIST_WRITE]);
  });
});

describe("parseScopeRequest", () => {
  it("grants offered scopes in the provider's order, offline_access last", () => {
    expect(parseScopeRequest("offline_access identity:read ratings:read", LIBRARY)).toEqual({ ok: true, scopes: ["ratings:read", "identity:read", OFFLINE_ACCESS] });
    expect(parseScopeRequest("critic-scores:read", REVIEWS)).toEqual({ ok: true, scopes: ["critic-scores:read"] });
    expect(parseScopeRequest(`wantlist-suggestions:read ${WANTLIST_WRITE}`, REVIEWS)).toEqual({ ok: true, scopes: ["wantlist-suggestions:read", WANTLIST_WRITE] });
    expect(parseScopeRequest("  ratings:read   listens:read ", LIBRARY)).toEqual({ ok: true, scopes: ["ratings:read", "listens:read"] });
  });

  it.each(["openid email", "openid ratings:read", "critic-scores:read profile", "offline_access", "", undefined])("refuses %j", (scope) => {
    expect(parseScopeRequest(scope, [...LIBRARY, ...REVIEWS]).ok).toBe(false);
  });

  it("refuses openid with its own reason, even next to offered scopes", () => {
    expect(parseScopeRequest("openid ratings:read", LIBRARY)).toEqual({ ok: false, reason: "openid is not offered" });
  });

  it("refuses a repeated scope", () => {
    expect(parseScopeRequest("ratings:read ratings:read", LIBRARY)).toEqual({ ok: false, reason: "a scope is repeated" });
    expect(parseScopeRequest("ratings:read offline_access offline_access", LIBRARY)).toEqual({ ok: false, reason: "a scope is repeated" });
  });

  it("refuses a scope the provider does not offer, a protocol scope included", () => {
    expect(parseScopeRequest("critic-scores:read", LIBRARY)).toMatchObject({ ok: false, reason: "not offered: critic-scores:read" });
    expect(parseScopeRequest("ratings:write", LIBRARY).ok).toBe(false);
    expect(parseScopeRequest("ratings:read", REVIEWS).ok).toBe(false);
    expect(parseScopeRequest("ratings:read\tidentity:read", LIBRARY).ok).toBe(false);
  });

  it("offline_access only alongside a capability scope", () => {
    expect(parseScopeRequest("offline_access", LIBRARY)).toEqual({ ok: false, reason: "ask for at least one capability scope" });
    expect(parseScopeRequest("offline_access ratings:read", LIBRARY).ok).toBe(true);
  });

  it("caps an echoed unknown scope at 200 characters", () => {
    const r = parseScopeRequest(`x:${"a".repeat(500)}`, LIBRARY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeLessThanOrEqual("not offered: ".length + 200);
  });
});

function manifest(provides: Manifest["provides"]): Pick<Manifest, "provides"> {
  return { provides };
}
const REVIEW_SERVICE = manifest({ "critic-scores": "/mc/v1/critic-scores", identity: "/mc/v1/identity", "wantlist-suggestions": "/mc/v1/wantlist-suggestions" });
const LIBRARY_CONSUMES: Capability[] = ["critic-scores", "identity", "wantlist-suggestions"];

describe("client scope derivation", () => {
  it("asks for what it consumes and the remote provides, write only with wantlist suggestions, offline_access last", () => {
    expect(linkScopes(REVIEW_SERVICE, LIBRARY_CONSUMES)).toEqual(["critic-scores:read", "identity:read", "wantlist-suggestions:read", WANTLIST_WRITE, OFFLINE_ACCESS]);
  });

  it("no wantlist write without wantlist suggestions", () => {
    expect(linkScopes(manifest({ "critic-scores": "/a", ratings: "/r" }), LIBRARY_CONSUMES)).toEqual(["critic-scores:read", OFFLINE_ACCESS]);
  });

  it("never asks for what it does not consume", () => {
    expect(linkScopes(manifest({ ratings: "/r", collection: "/c", listens: "/l", identity: "/i" }), LIBRARY_CONSUMES)).toEqual(["identity:read", OFFLINE_ACCESS]);
  });

  it("nothing shared: no scopes at all (no lone offline_access)", () => {
    expect(linkScopes(manifest({ ratings: "/r" }), LIBRARY_CONSUMES)).toEqual([]);
  });

  it("pulls only granted capabilities; the rest are available, re-link to grant", () => {
    expect(sharedCapabilities(REVIEW_SERVICE, LIBRARY_CONSUMES)).toEqual(LIBRARY_CONSUMES);
    expect(pullableCapabilities(REVIEW_SERVICE, ["critic-scores:read"], LIBRARY_CONSUMES)).toEqual(["critic-scores"]);
    expect(availableUngranted(REVIEW_SERVICE, ["critic-scores:read"], LIBRARY_CONSUMES)).toEqual(["identity", "wantlist-suggestions"]);
    expect(capabilityScopes(["critic-scores:read", OFFLINE_ACCESS, ""])).toEqual(["critic-scores:read"]);
  });
});
