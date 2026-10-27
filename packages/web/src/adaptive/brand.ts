/**
 * The brand values of every --ad-* property (tokens.css, "Porcelain & Dew"),
 * per theme. Turning adaptive colour off fades the --ad-* properties to these
 * and then drops data-adaptive, so leaving is as smooth as arriving.
 */
export const BRAND_TOKENS: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    '--ad-accent': '#276a82', '--ad-accent-hi': '#5ba8c4', '--ad-accent-lo': '#1c556b', '--ad-accent-press': '#164556',
    '--ad-accent-hover': '#1c556b', '--ad-accent-ink': '#ffffff', '--ad-tint': '#e3f0f5', '--ad-chip': '#1c556b', '--ad-ring': '#276a82',
    '--ad-canvas': '#f6f8fa', '--ad-wash': 'rgba(227, 240, 245, 0.7)', '--ad-bar': '#f8f9fa', '--ad-bar-ink': '#16202a',
    '--ad-bar-ink-2': '#46525e', '--ad-bar-line': '#c3ccd5', '--ad-bar-accent': '#276a82', '--ad-bar-danger': '#a83a36', '--ad-glow': '#00c5f7', '--accent-rgb': '39, 106, 130', '--info-rgb': '39, 106, 130',
  },
  dark: {
    '--ad-accent': '#5fb0cc', '--ad-accent-hi': '#9ad3e6', '--ad-accent-lo': '#2f7f9c', '--ad-accent-press': '#7fc3da',
    '--ad-accent-hover': '#9ad3e6', '--ad-accent-ink': '#04202a', '--ad-tint': '#16303a', '--ad-chip': '#9ad3e6', '--ad-ring': '#8acbe0',
    '--ad-canvas': '#0d1115', '--ad-wash': 'rgba(22, 48, 58, 0.55)', '--ad-bar': '#171e25', '--ad-bar-ink': '#e7edf2',
    '--ad-bar-ink-2': '#a9b5c0', '--ad-bar-line': '#3a4651', '--ad-bar-accent': '#5fb0cc', '--ad-bar-danger': '#e0716b', '--ad-glow': '#005c76', '--accent-rgb': '95, 176, 204', '--info-rgb': '95, 176, 204',
  },
};
