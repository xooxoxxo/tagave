import { toJSONSchema } from "zod/v4/core";
import { CAPABILITY_DATA } from "./schemas.js";
import type { Capability } from "./capabilities.js";
export function capabilityJsonSchema(c: Capability): object {
  // schemas.ts uses zod/v4 (zod 3.25 ships it); toJSONSchema rejects v3-API schemas.
  return toJSONSchema(CAPABILITY_DATA[c] as never) as object;
}
