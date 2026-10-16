import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("the main entry is pure", () => {
  it("imports no node: module; Node-only code lives in music-connections/node", () => {
    const dir = join(import.meta.dirname, "..", "src");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/from\s+["']node:/);
  });
});
