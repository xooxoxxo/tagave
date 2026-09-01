import { z } from 'zod';

/**
 * Cursor pagination envelope
 * Per spec Section 13: cursor pagination everywhere
 * Generic envelope for any item type
 */
export function paginationEnvelopeSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema).describe('Array of items for this page'),
    nextCursor: z.string().nullable().optional().describe('Cursor for the next page, null if no more items'),
  }).strict();
}

/**
 * Cursor pagination request parameters
 */
export const paginationParamsSchema = z.object({
  cursor: z.string().optional().describe('Cursor from a previous response'),
  limit: z.number().int().min(1).max(500).default(50).describe('Items per page'),
}).strict();

export type PaginationParams = z.infer<typeof paginationParamsSchema>;

/**
 * Generic envelope type (requires specifying item type at runtime)
 */
export interface PaginationEnvelope<T> {
  items: T[];
  nextCursor?: string | null;
}
