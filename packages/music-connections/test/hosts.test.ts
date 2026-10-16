import { describe, expect, it } from "vitest";
import { canonicalHttpUrl, isAllowedRedirect, isAllowedRegistration, isAllowedRemote, isPrivateHost, parseTrustedHosts } from "../src/index.js";

describe("isAllowedRedirect", () => {
  it.each([
    ["http://192.168.1.10:3100/connections/callback", true],
    ["http://100.64.0.10/cb", true],
    ["http://100.127.255.254/cb", true],
    ["http://localhost:5173/cb", true],
    ["http://127.0.0.1/cb", true],
    ["http://127.0.0.1:9/cb", true],
    ["http://10.1.2.3/cb", true],
    ["http://172.16.5.5/cb", true],
    ["http://172.20.0.5:3000/cb", true],
    ["http://172.32.0.1/cb", false],
    ["http://100.128.0.1/cb", false],
    ["https://music.example.com/cb", false],
    ["http://8.8.8.8/cb", false],
    ["javascript:alert(1)", false],
    ["http://192.168.1.10.evil.com/cb", false],
    ["http://review-gatherer:3000/", false],
    // IPv6 literals are never on the allow-list; localhost is the loopback name
    ["http://[::1]:8080/cb", false],
    ["http://[fd12::1]/cb", false],
  ])("%s → %s", (u, ok) => expect(isAllowedRedirect(u, [])).toBe(ok));

  it("allows an explicitly trusted public host over https only", () => {
    expect(isAllowedRedirect("https://music.example.com/cb", ["music.example.com"])).toBe(true);
    expect(isAllowedRedirect("http://music.example.com/cb", ["music.example.com"])).toBe(false);
  });

  it("takes only the canonical form, without fragment, user info, comma or whitespace", () => {
    for (const u of [
      "http://10.1.2.3:8080/cb#frag",
      "http://10.1.2.3:8080/a,http://evil.example/",
      "HTTP://10.1.2.3/cb",
      "http://10.1.2.3",
      "http://user:pw@10.1.2.3/cb",
      "http://10.1.2.3/c b",
      " http://10.1.2.3/cb",
      `http://10.1.2.3/${"a".repeat(2048)}`,
      "",
    ]) {
      expect(isAllowedRedirect(u, []), u).toBe(false);
    }
    expect(isAllowedRedirect(42, [])).toBe(false);
    expect(isAllowedRedirect(undefined, [])).toBe(false);
  });
});

describe("the registration redirect policy", () => {
  it("exactly one allowed redirect URI", () => {
    expect(isAllowedRegistration(["http://10.1.2.3/cb"], [])).toBe(true);
    expect(isAllowedRegistration(["http://127.0.0.1/cb", "http://10.9.9.9/cb"], [])).toBe(false);
    expect(isAllowedRegistration([], [])).toBe(false);
    expect(isAllowedRegistration("http://10.1.2.3/cb", [])).toBe(false);
    expect(isAllowedRegistration(undefined, [])).toBe(false);
    expect(isAllowedRegistration(["https://music.example.com/cb"], [])).toBe(false);
    expect(isAllowedRegistration(["https://music.example.com/cb"], ["music.example.com"])).toBe(true);
    // the comma smuggle: one string carrying two URIs
    expect(isAllowedRegistration(["http://127.0.0.1/cb,https://evil.example/steal"], [])).toBe(false);
  });
});

describe("parseTrustedHosts", () => {
  it("trims, lower-cases, drops a trailing dot and empties", () => {
    expect(parseTrustedHosts(" Music.Example.com. , ,OTHER.example.org")).toEqual(["music.example.com", "other.example.org"]);
    expect(parseTrustedHosts("")).toEqual([]);
    expect(parseTrustedHosts(undefined)).toEqual([]);
    expect(isAllowedRedirect("https://music.example.com/cb", parseTrustedHosts("MUSIC.example.com"))).toBe(true);
  });
});

describe("isPrivateHost", () => {
  it("localhost and private, CGNAT and loopback IPv4 literals", () => {
    for (const h of ["localhost", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "127.0.0.1"]) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "[::1]", "::1", "example.lan", "010.0.0.1", "256.1.1.1"]) expect(isPrivateHost(h), h).toBe(false);
  });
});

describe("isAllowedRemote", () => {
  it("is wider than the redirect gate: a DNS name passes, to be checked on what it resolves to", () => {
    expect(isAllowedRemote("http://review-gatherer:3000/", [])).toBe(true);
    expect(isAllowedRedirect("http://review-gatherer:3000/", [])).toBe(false);
    expect(isAllowedRemote("https://music.example.com/", [])).toBe(true);
  });

  it("refuses *.localhost, a trailing dot, bad labels and public or IPv6 literals", () => {
    for (const u of ["http://rg.localhost/", "http://localhost./", "http://rg.example.com./", "http://under_score.lan/", "http://-bad.lan/",
      "http://8.8.8.8/", "http://[::1]/", "http://[2606:4700::1111]/", "http://169.254.169.254/", "http://0.0.0.0:8080/", "ftp://10.1.2.3/"]) {
      expect(isAllowedRemote(u, []), u).toBe(false);
    }
  });
});

describe("canonicalHttpUrl", () => {
  it("returns the URL only for the canonical http(s) form", () => {
    expect(canonicalHttpUrl("http://10.1.2.3/x")?.hostname).toBe("10.1.2.3");
    expect(canonicalHttpUrl("http://10.1.2.3")).toBeNull();
    expect(canonicalHttpUrl("file:///etc/passwd")).toBeNull();
  });
});
