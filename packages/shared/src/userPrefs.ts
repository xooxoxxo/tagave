/**
 * Each person's own preferences, kept on the server so they follow the
 * person between devices (0059, user_prefs): the colour theme of
 * Settings › Appearance, and the DJ module's Simple mode (0087). Light /
 * Dark / Auto stays per device.
 *
 *   GET /api/v1/me/prefs   self: { theme, dj } (each null until the person picks one)
 *   PUT /api/v1/me/prefs   self: { theme?, dj? }
 */
import { z } from 'zod';
import { djSimpleSettingsSchema, type DjSimpleSettings } from './dj.js';

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
  /** the DJ module's Simple mode (0087); null until the person changes it */
  dj: DjSimpleSettings | null;
}

/** PUT /me/prefs: the parts that change (each written alone, the others kept). */
export const userPrefsUpdateSchema = z.object({
  theme: themeChoiceSchema.optional(),
  dj: djSimpleSettingsSchema.optional(),
}).strict().refine((v) => v.theme !== undefined || v.dj !== undefined, { message: 'theme or dj' });
