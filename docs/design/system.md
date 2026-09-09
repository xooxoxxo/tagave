# Liner UI system

The canonical tokens live in `packages/web/src/styles/index.css`. Use CSS Modules and semantic tokens for new interfaces.

## Foundations

- Page surface: `--bg-primary` (#f7f8f5). Content surfaces: `--bg-secondary` (white). Quiet controls: `--bg-tertiary`.
- Text: `--text-primary`, `--text-secondary`, `--text-tertiary`. Keep secondary text readable; do not lower opacity on body copy.
- Accent: `--accent` (#246b5c), with hover and pressed variants. Status colors convey actual state, not decoration.
- Spacing: use the `--space-*` scale. Page gutters use `--page-pad`; `--content-max` bounds wide layouts.
- Typography: use `--font-size-*`; page headings use the responsive 2xl size. Counts use tabular numerals.
- Radius: small for artwork and labels, medium for controls, large for grouped content.
- Motion: brief color feedback, restrained artwork hover; respect reduced motion.

## Page composition

Use PageShell for title, description, actions, and optional tabs. Child content should not repeat its outer gutters or render another full page heading. Ordinary pages scroll through the application main region; the album browser has a bounded viewport for virtualization. Keep the legal attribution in document flow.

Home leads with real album data. Music browsing is grouped separately from Library care and Tag changes. Settings navigation opens one focused panel at a time. Preserve URL search parameters for bookmarkable album filters and existing settings redirects.

## Controls and state

Use shared Button, Tabs, Card, Banner, Table, and EmptyState components where applicable. Filled buttons indicate a primary action; secondary controls use neutral surfaces. Group dense maintenance actions in labeled disclosure panels. Keep errors and pending states adjacent to their operation.

Loading, empty, and failed data are distinct states. Never present missing counts as zero. Provide a useful next step for empty content and retry for failed requests. Use actual album artwork; missing artwork uses a neutral fallback.

Keyboard users must be able to see focus. Search supports arrows, Enter, Escape, a close control, trapped focus, and focus restoration. Tab lists use a single tab stop with arrow-key navigation. Give search fields and icon controls accessible names. Responsive layouts must preserve access to all navigation and actions.
