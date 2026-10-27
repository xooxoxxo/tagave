/**
 * Each person's own preferences, kept on the server so they follow the
 * person between devices (0059, user_prefs): the colour theme of
 * Settings › Appearance. Light / Dark / Auto stays per device.
 *
 *   GET /api/v1/me/prefs   self: { theme } (null until the person picks one)
 *   PUT /api/v1/me/prefs   self: { theme }
 */
import { z } from 'zod';

/** The starters, in the order the gallery shows them. */
export const THEME_IDS = ['adaptive', 'classic', 'moody', 'mono', 'custom'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, '#rrggbb');

/** A theme: a seed colour, optionally a second accent for the player, optionally near-greyscale. */
export const themeSpecSchema = z.object({
  seed: hex,
  accent2: hex.nullable().optional(),
  mono: z.boolean().optional(),
}).strict();
export type ThemeSpec = z.infer<typeof themeSpecSchema>;

/** The stored choice: the theme, and the person's Custom (kept when another theme is picked). */
export const themeChoiceSchema = z.object({
  theme: z.enum(THEME_IDS),
  custom: themeSpecSchema.nullable(),
}).strict();
export type ThemeChoice = z.infer<typeof themeChoiceSchema>;

export interface UserPrefsView {
  theme: ThemeChoice | null;
}

export const userPrefsUpdateSchema = z.object({ theme: themeChoiceSchema }).strict();
