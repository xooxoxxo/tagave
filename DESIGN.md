# Liner design system

## Purpose and visual direction

A light, calm music catalog. Music identity comes first; technical metadata, maintenance, and provenance use progressive disclosure. Preserve the compact centered disclaimer bar. PRODUCT.md owns product strategy.

## Sources of truth

- `packages/web/src/styles/tokens.css`: canonical visual tokens.
- `packages/web/src/styles/index.css`: baseline and compatibility rules.
- `packages/web/src/components/ui/`: production components.
- `packages/web/design-system.html`: interactive development catalog, served by Vite at `/design-system.html`. It is not a production route or part of the default production build.

## Color and surfaces

| Role | Token | Value / purpose |
| --- | --- | --- |
| Canvas | `--bg-primary` | #f7f8f5 |
| Content | `--bg-secondary` | #ffffff |
| Quiet surface | `--bg-tertiary` | #eef1ec |
| Navigation | `--bg-nav` | #f0f3ee |
| Main text | `--text-primary` | #202b28 |
| Secondary text | `--text-secondary` | #52605b |
| Muted text / placeholders | `--text-tertiary` | #5f6c65 |
| Primary action | `--accent` | #246b5c |
| Selection | `--surface-selected`, `--text-selected` | Paired background and foreground |
| Status | `--surface-success/warning/danger/info` | Paired with `--success/warning/error/info` |

Use status text as well as color. A badge describes state; it is not an action. Use the semantic status surfaces instead of independently mixing arbitrary opacity values. RGB aliases remain for compatibility with older pages.

## Typography and spacing

One system sans family. Fixed sizes: 12, 14, 16, 18, 20, 32px. Page titles use 32px, section titles 20px, controls and table data 14px. Keep heading tracking at or above -0.03em. Numeric data uses tabular figures.

Spacing: 4, 8, 12, 16, 24, 32, 48px. Page gutters use `--page-pad`. Shared component interiors use spacing tokens, never page gutters. Radius: 5px for badges, 8px for controls, 14px for grouped surfaces. Tabs have square corners and a straight underline.

## Component contracts

### Button and LinkButton

Variants: primary, secondary, ghost, danger. Sizes: small (32px), medium (40px). Use one clear primary action per task. `Button` defaults to `type="button"`; form submission must explicitly set `type="submit"`. `loading` disables repeat activation and sets `aria-busy`; callers provide an informative label such as “Saving changes…”.

Use `LinkButton` for navigation. Never put a link inside a button. Context-specific inline actions can remain plain links.

### Input, Select, Textarea, TextField

`Input`, `Select`, and `Textarea` accept native element props and forward refs. Use a visible label or an accessible name. Their shared appearance includes hover, focus, disabled, and invalid states.

`TextField` owns the label, ID, required marker, hint, error message, and `aria-describedby` connection. Error text replaces hint text. Keep the current value after a failed request.

```tsx
<TextField label="Library name" value={name} onChange={e => setName(e.target.value)}
  hint="Choose a name you recognize." error={nameError} required />
<Button type="submit" loading={saving}>{saving ? 'Saving changes…' : 'Save changes'}</Button>
```

Use native checkboxes and radio controls with labels. Do not apply the text-input component to those controls.

### Tabs and PageShell

Tabs support Left/Right wrapping and Home/End, with one tab stop. Provide a meaningful `label` and the ID of the actual rendered `panelId`. Do not invent IDs for panels that do not exist. PageShell generates its own unique panel ID for integrated tabs.

Tabs change a local section. Navigation between Albums and Artists uses links in the application navigation, not a second tab model.

### Badge, Banner, Card, Table, EmptyState

Badges are compact rectangular status text. Banners explain an outcome or actionable condition with a full border and tinted surface. Cards group related content, never nest inside another card for decoration. Tables scroll within their own container on narrow screens. Empty states distinguish absent content from failed requests and should explain the next useful step.

## Interaction and accessibility

Use `--focus-ring`, `--focus-offset`, and shared control heights. Transitions communicate state, with reduced motion respected globally. Status and placeholder contrast must remain at least 4.5:1 for ordinary text. Contrast checks are a regression safeguard, not a claim of complete accessibility certification.

Layers progress from sticky content to backdrop, dropdown, modal, toast, tooltip. Never introduce local arbitrary z-index values for a shared overlay.

## Adoption and compatibility

New or changed forms use the shared form controls. Albums, Artists, and tag-change details have been migrated. Other existing page-specific controls remain on compatible baseline styles and can be migrated when their surfaces are changed. Global legacy button selectors have zero specificity, so they cannot override component states.

Do not introduce new hard-coded status backgrounds, independent input styles, oversized metric cards, or pill-style metadata lists. Extract only patterns with at least three comparable uses. Extend the catalog whenever a shared component gains a new variant.

## Validation

Run web type checking, Vite build, and Vitest. Inspect the catalog at desktop and narrow widths; exercise field validation, disabled/loading buttons, tab arrow keys, and error/status examples. Verify migrated screens with real data where available; clearly identify any API fixtures used for UI checks.
