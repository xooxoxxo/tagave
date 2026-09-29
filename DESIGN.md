# tagave design system: Porcelain & Dew

A calm, airy catalogue with plenty of whitespace. Surfaces stay flat and quiet, and the controls you press are the tactile part of the interface: glossy, translucent drops that look soft and 3D. PRODUCT.md covers product strategy.

## Sources of truth

- `packages/web/src/styles/tokens.css`: every colour, type, space, radius, motion and layer token, for light and dark.
- `packages/web/src/styles/index.css`: baseline element styles. They are wrapped in `:where()`, so any class overrides them.
- `packages/web/src/components/ui/`: production primitives.
- `packages/web/src/theme.ts`: the theme preference (system, light or dark).
- `packages/web/design-system.html`: a live catalogue of every primitive in both themes. Vite serves it at `/design-system.html` during development. It is not a production route.

## Principles

1. **Quiet stage, tactile actors.** Surfaces are flat and hairlines are 1px. Content gets no decorative gradients. Depth, gloss and colour are only for things you can press. If everything shines, nothing does.
2. **Thin display, sturdy body.** The display face at weight 200 or 300 carries the elegance. Body text is never lighter than 400. Data is never set in the display face.
3. **One accent, dew blue.** The only other hue is danger. Status colours are desaturated and appear only as small dots or tinted notes, never as fills.
4. **Air.** Sections sit 72 to 96px apart and cards have 20 to 24px of padding. Content is at most 1080px wide on marketing pages and 1280px in the app.
5. **Same drop, both themes.** In dark mode the primary button stays the same dew drop, lit from inside: a lighter body with a dark label. It is never inverted.

## Typography

The faces are Urbanist (display), Figtree (body and controls) and JetBrains Mono (paths, tag keys and diffs). They are Google Fonts, self-hosted through `@fontsource` so an offline homelab still gets them. The app never calls a font CDN.

| Role | Token | Face and size | Use |
| --- | --- | --- | --- |
| display | `--type-display` | Urbanist 200, clamp(44–88px) / 1.02, -0.025em | Landing hero, empty-state hero |
| headline | `--type-headline` | Urbanist 300, clamp(28–40px) / 1.15 | Page titles (`h1`, PageShell) |
| title | `--type-title` | Urbanist 400, 22px / 1.3 | Card titles, section heads (`h2`) |
| body-lg | `--type-body-lg` | Figtree 400, 18px / 1.6 | Lede paragraphs |
| body | `--type-body` | Figtree 400, 16px / 1.6 (tables 14px) | Everything someone reads |
| ui | `--type-ui` | Figtree 500/600, 15px | Buttons, tabs, navigation |
| label | `--type-label` | Figtree 500, 12px, uppercase, 0.14em | Eyebrows, column heads |
| mono | `--type-mono` | JetBrains Mono 400, 14px (13px in tables) | Paths, tag keys, diffs, commands |

Rules:

- Below 28px, never use a weight under 300.
- Below 40px, never use a weight under 200.
- Durations, counts and track numbers use `font-variant-numeric: tabular-nums`.
- At most once per page, one hero word may be set in `--dew`.

## Colour

Components use the palette tokens. Legacy names such as `--bg-primary`, `--text-secondary`, `--accent` and `--surface-success` still exist for older pages. They resolve to the palette, so those pages follow the theme too.

| Role | Token | Light | Dark |
| --- | --- | --- | --- |
| Canvas | `--canvas` | #F6F8FA | #0D1115 |
| Surface (cards) | `--surface` | #FFFFFF | #141A20 |
| Recessed / hover | `--mist` | #EBEFF3 | #1B232B |
| Hairline | `--line` | #DCE2E8 | #29333D |
| Text | `--ink` / `--ink-2` / `--ink-3` | #16202A / #46525E / #5E6975 | #E7EDF2 / #A9B5C0 / #8795A2 |
| Accent | `--dew` (with `-hi`, `-lo`, `-tint`) | #276A82 | #5FB0CC |
| Label on accent | `--dew-ink` (legacy `--on-accent`) | #FFFFFF | #04202A |
| Danger | `--danger`, `--danger-ink` | #A83A36 / white | #E0716B / #2A0706 |
| Status dots | `--ok`, `--warn` | #387352, #8A5E0E | #6DBE8F, #D9A94A |
| Focus ring | `--ring` | #276A82 | #8ACBE0 |

`tokenContrast.test.ts` uses the WCAG formula to check every ink-on-fill pair the primitives use, in both themes. Text pairs must reach 4.5:1 and focus rings and status dots must reach 3:1. The same test checks that the two dark blocks (the OS setting and the explicit choice) are identical. Measured values differ slightly from the original specimen: `--ink-3`, `--ok` and `--warn` were darkened in light mode so that they pass on `--mist` and their tints.

**Themes.** Light is the default. The dark palette applies when the OS prefers dark, unless the viewer chose light, or whenever `data-theme="dark"` is set. Settings > Appearance has a System / Light / Dark switch (`ThemeSwitch`). The choice is stored in `localStorage` under the key `tagave-theme`, with every access guarded. An inline script in `index.html` applies the choice before first paint.

## Scale

- Space: `--space` is 4px, with steps of 4, 8, 12, 16, 20, 24, 32, 40, 48, 72 and 96px (`--space-xs` to `--space-4xl`).
- Radius: `--r-pill` for every control, `--r-card` 24px, `--r-cover` 18px, `--r-inner` 14px (textareas, thumbnails, notes) and `--r-kbd` 8px. No control is square or has a small radius.
- Controls: `--h-control` 48px, `--h-control-sm` 36px, `--h-chip` 30px. On coarse pointers a small control grows to 44px.
- Motion: `--dur-fast` 80ms (press), `--dur` 180ms, `--dur-slow` 280ms, `--ease-out`, and `--ease-spring`, which is used only for hover lift.

## Buttons: the drop

`Button` takes `variant` (`primary | secondary | quiet | danger`, where the older `ghost` is the same as `quiet`), `size` (`md | sm`), `icon`, and `loading`. The label is always rendered inside a child `<span>` so that it sits above the gloss layers. `IconButton` is a circular drop that needs a `label` for its accessible name. `LinkButton` takes the same props for navigation. Never put a link inside a button.

A drop is built from these layers, back to front:

1. A metallic rim: a 1.5px gradient border drawn with the `padding-box` / `border-box` double background.
2. The body gradient, with a glow rising from below.
3. A top inner highlight and a bottom inner shade.
4. A tinted drop shadow.
5. A specular sheen over the top 46%, capped at 0.40 alpha on primary so the white label keeps its contrast.
6. A small caustic glint, only on buttons 40px or taller.

States:

- Hover lifts the button 1px and scales primary and danger to 101.5%.
- Press sinks it 1px, scales it to 97% and turns the shadow inset, over 80ms.
- Focus shows a 2px `--ring` outline with a 3px offset.
- Disabled is desaturated at half opacity.
- Loading keeps the width and colour, swaps the label for a spinner (the label stays in the accessibility tree), sets `aria-busy` and blocks repeat presses.

Variants:

- **Primary:** the dew drop. Use at most one per view.
- **Secondary:** a clear frosted bubble.
- **Quiet:** text in `--dew` until touched.
- **Danger:** the same drop with the danger tint. Always confirm before a danger action runs, and never place a danger button next to the primary without a quiet Cancel between them.

`Button` defaults to `type="button"`. A form's submit button must set `type="submit"`. Labels are verbs in sentence case, one to three words.

Accessibility and fallbacks: reduced motion turns every transform off. Forced-colours mode switches to system `ButtonFace` / `ButtonText` with a 2px border and no gloss. Where `backdrop-filter` is unsupported, the secondary bubble falls back to an opaque surface.

## Other primitives

- **Input, Select, Textarea, TextField:** recessed pills, 48px tall (36px with `dense`), with a 1px `--line` border and an inner shadow. Focus turns the border `--dew` and adds a 4px dew halo. `TextField` owns the label, ID, required marker, hint, error and `aria-describedby`. Its `previousValue` shows a pending change struck through, with a dew dot, for bulk tag editing. A blank previous value reads "(empty)", never nothing. Textareas use `--r-inner`. Checkboxes and radios stay native, with `accent-color`.
- **SearchField:** a search pill with a leading icon and a trailing `/` hint. It needs a `label` for its accessible name. Pressing `/` anywhere outside a text field focuses it.
- **Chip:** a 30px pill in Figtree 500 13px. With `onClick` it becomes a toggle button with `aria-pressed`. An `active` chip uses a dew tint with a deep dew label. `dot` adds a 6px status dot. Chips never get the glint.
- **Badge:** a quiet status pill. The state is written in words, and the colour appears only as a dot. `statusTone()` maps plan and job states to a tone.
- **Banner:** a flat tinted note (`--r-inner`) with a status dot. It explains an outcome or a condition the viewer can act on.
- **Card, StatCard, Surface:** cards are opaque `--surface` with a 1px `--line` border, `--r-card` and a soft long shadow. They get no gloss and never nest for decoration. StatCard values are body-face, tabular data. `Surface variant="glass"` is only for layers that float over content: popovers, the sticky plan bar, toasts. Never put glass on glass or behind large scrolling areas.
- **Tabs:** a recessed pill track. The active tab is a clear bubble resting in it. There is one tab stop, and Left/Right (wrapping), Home and End move between tabs. Pass the real `panelId`. Tabs switch a local section; use navigation links to move between pages.
- **SegmentedControl / ThemeSwitch:** native radio buttons in the same pill track.
- **Tooltip:** a small glass label that opens on hover and focus. It closes on Escape, blur or pointer leave, can itself be hovered, and adds `aria-describedby` to its trigger. Use it only for supplementary text.
- **Table:** 44px rows with hairline dividers, no zebra stripes and `--mist` on hover. Column heads use the label style. Numbers are tabular. The table scrolls inside its own container on narrow screens.
- **EmptyState:** a headline in the display face plus one sentence about the next useful step. Keep "nothing here" separate from "failed to load".

## Layout and motion

- Page gutters use `--page-pad`, which drops to 16px on phones. Every page must be free of horizontal scroll at 400px wide.
- Button groups wrap with 14px gaps.
- Popovers fade in and rise 4px (180ms, ease-out). Sticky bars and toasts slide up (280ms). Nothing loops, pulses or shimmers at rest.
- Layers stack in this order: sticky, backdrop, dropdown, modal, toast, tooltip (`--z-*`). Never add a local z-index for a shared overlay.

## Do and don't

**Do**

- Keep 90% of every screen flat, quiet and divided by hairlines.
- Use Urbanist 200/300 at large sizes and Figtree for anything someone has to read.
- Reserve the dew accent for the primary button, links, focus and active chips.
- Check both themes and a 400px width on every UI change.
- Measure contrast for any new ink-on-fill pair and add it to the contrast test.

**Don't**

- Don't put gloss, rims or sheen on cards, inputs, tables or navigation.
- Don't use purple gradients, cream with terracotta, neon on black, or a second accent hue.
- Don't use square or small-radius buttons.
- Don't set body text, table data or labels in the display face.
- Don't invert the primary button between themes.
- Don't hard-code colours in page CSS. Use the tokens so both themes work.

## Adoption

The primitives and baseline styles use this system. Pages keep working through the legacy token names and the baseline styles, and they are restyled page by page. When a page is touched:

1. Replace its local buttons, inputs and pills with the primitives.
2. Replace its hard-coded colours (hex, `white`, `rgba(0,0,0,…)`) with tokens.

Extract a new pattern into `components/ui` only after it has at least three comparable uses, and add each new variant to the catalogue.

## Validation

Run web type checking, the Vite build and Vitest for `@liner/web`. The contrast and primitive-contract tests live in `components/ui`. In the catalogue, at desktop width and at 400px, in both themes, check:

- the button states: hover, press, focus, disabled, loading
- field validation
- tab arrow keys
- tooltips with the keyboard
