/**
 * Reads the design tokens from the loaded stylesheet (tokens.css), so the
 * Foundations pages list exactly what the app ships: nothing is copied here.
 */
export interface Token { name: string; declared: string }

/** Custom properties declared on the first plain :root rule (the light palette and the scale). */
export function readRootTokens(): Token[] {
  const tokens: Token[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || rule.selectorText !== ':root') continue;
      for (let i = 0; i < rule.style.length; i++) {
        const name = rule.style.item(i);
        if (name.startsWith('--')) tokens.push({ name, declared: rule.style.getPropertyValue(name).trim() });
      }
      if (tokens.length) return tokens;
    }
  }
  return tokens;
}

/** The value a token resolves to in the current theme. */
export function resolved(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

const LEGACY_START = '--bg-primary';

/** Tokens from layers 1 and 2 only: the legacy aliases (layer 3) resolve to these. */
export function currentTokens(): Token[] {
  const all = readRootTokens();
  const cut = all.findIndex((t) => t.name === LEGACY_START);
  return cut === -1 ? all : all.slice(0, cut);
}

export function legacyTokens(): Token[] {
  const all = readRootTokens();
  const cut = all.findIndex((t) => t.name === LEGACY_START);
  return cut === -1 ? [] : all.slice(cut);
}

export const isColour = (declared: string) => /^(#|rgba?\(|color-mix\()/.test(declared) && !declared.includes('var(--shadow-tint)');
