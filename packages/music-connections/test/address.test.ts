import { describe, expect, it } from "vitest";
import { isIP } from "node:net";
import { LinkError, addressAllowed, checkResolvedAddresses, classifyAddress, ipVersion, isLiteralLoopback, isTrustedName, v6Groups } from "../src/index.js";

describe("classifyAddress", () => {
  it("classifies the always-blocked ranges, whatever form they take", () => {
    for (const ip of ["169.254.169.254", "169.254.0.1", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.250", "255.255.255.255", "240.0.0.1",
      "::", "fe80::1", "febf::1", "ff02::1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:0.0.0.0", "64:ff9b::a9fe:a9fe", "::169.254.169.254",
      "not-an-ip", "", "1.2.3", "1:2:3", "::1::", "12345::"]) {
      expect(classifyAddress(ip), ip).toBe("blocked");
    }
  });

  it("loopback, private and public", () => {
    for (const ip of ["127.0.0.1", "127.255.255.254", "::1", "[::1]", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) expect(classifyAddress(ip), ip).toBe("loopback");
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.254", "fd12::1", "fc00::1", "::ffff:192.168.1.1", "64:ff9b::a01:203"]) {
      expect(classifyAddress(ip), ip).toBe("private");
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(classifyAddress(ip), ip).toBe("public");
  });
});

describe("the pure IP parser agrees with node:net", () => {
  it.each([
    "1.2.3.4", "255.255.255.255", "256.1.1.1", "01.2.3.4", "1.2.3", "::", "::1", "1::", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9", "1::2::3",
    "::ffff:1.2.3.4", "::ffff:1.2.3.256", "fe80::1%eth0", "fe80::1%", "1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:7:1.2.3.4", "abcde::1", "g::1", ":1::",
    "1:2:3:4:5:6:7::", "::1:2:3:4:5:6:7", "localhost", "",
  ])("%s", (s) => {
    expect(ipVersion(s)).toBe(isIP(s));
  });

  it("expands groups and embedded quads", () => {
    expect(v6Groups("::ffff:169.254.169.254")).toEqual([0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe]);
    expect(v6Groups("[fd12::1]")).toEqual([0xfd12, 0, 0, 0, 0, 0, 0, 1]);
    expect(v6Groups("1.2.3.4")).toBeNull();
  });
});

describe("addressAllowed", () => {
  it("loopback only for a literally loopback host, never a name resolving there", () => {
    expect(addressAllowed("127.0.0.1", "127.0.0.1", false)).toBe(true);
    expect(addressAllowed("localhost", "127.0.0.1", false)).toBe(true);
    expect(addressAllowed("[::1]", "::1", false)).toBe(true);
    expect(addressAllowed("rg.example.com", "127.0.0.1", true)).toBe(false);
    expect(addressAllowed("localhost", "10.1.2.5", false)).toBe(false);
    expect(addressAllowed("review-gatherer", "10.1.2.5", false)).toBe(true);
    expect(addressAllowed("review-gatherer", "127.0.0.1", false)).toBe(false);
    expect(addressAllowed("rg.example.com", "169.254.169.254", true)).toBe(false);
    expect(addressAllowed("rg.example.com", "8.8.8.8", true)).toBe(true);
    expect(addressAllowed("rg.example.com", "8.8.8.8", false)).toBe(false);
    expect(addressAllowed("8.8.8.8", "8.8.8.8", true)).toBe(false);
  });

  it("isLiteralLoopback", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "[::1]"]) expect(isLiteralLoopback(h), h).toBe(true);
    for (const h of ["rg.localhost", "10.0.0.1", "[::2]", "loopback.lan"]) expect(isLiteralLoopback(h), h).toBe(false);
  });

  it("isTrustedName: a name in the list, over https, never a literal", () => {
    expect(isTrustedName(new URL("https://rg.example.com/x"), ["rg.example.com"])).toBe(true);
    expect(isTrustedName(new URL("https://RG.example.com/x"), ["rg.example.com"])).toBe(true);
    expect(isTrustedName(new URL("http://rg.example.com/x"), ["rg.example.com"])).toBe(false);
    expect(isTrustedName(new URL("https://8.8.8.8/x"), ["8.8.8.8"])).toBe(false);
  });
});

describe("checkResolvedAddresses", () => {
  const check = (url: string, ips: string[], trusted: string[] = []) => checkResolvedAddresses(new URL(url), ips, trusted);

  it("a LAN name may reach private addresses only: not loopback, not public, not a mix", () => {
    expect(check("http://review-gatherer:3000/", ["10.20.30.40"])).toBe("10.20.30.40");
    expect(() => check("http://sneaky.lan/", ["127.0.0.1"])).toThrow("address not allowed");
    expect(() => check("http://mixed.lan/", ["10.20.30.40", "93.184.216.34"])).toThrow("address not allowed");
    expect(() => check("https://public.example.com/", ["93.184.216.34"])).toThrow("address not allowed");
    expect(() => check("http://meta.lan/", ["169.254.169.254"])).toThrow(LinkError);
    expect(check("https://public.example.com/", ["93.184.216.34"], ["public.example.com"])).toBe("93.184.216.34");
    expect(() => check("http://public.example.com/", ["93.184.216.34"], ["public.example.com"])).toThrow("address not allowed");
  });

  it("a trusted name answering with a blocked or loopback address, or nothing, is refused", () => {
    const t = ["rg.example.com"];
    expect(() => check("https://rg.example.com/", ["169.254.169.254"], t)).toThrow("address not allowed");
    expect(() => check("https://rg.example.com/", ["93.184.216.34", "127.0.0.1"], t)).toThrow("address not allowed");
    expect(check("https://rg.example.com/", ["::ffff:10.0.0.1"], t)).toBe("::ffff:10.0.0.1");
    expect(() => check("https://rg.example.com/", [], t)).toThrow("remote unresolvable");
  });
});
