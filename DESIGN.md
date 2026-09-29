# tagave design system: Porcelain & Dew

A calm, airy catalogue with plenty of whitespace. Surfaces stay flat and quiet, and the controls you press are the tactile part of the interface: glossy, translucent drops that look soft and 3D. PRODUCT.md covers product strategy.

## Sources of truth

- `packages/web/src/styles/tokens.css`: every colour, type, space, radius, motion and layer token, for light and dark.
- `packages/web/src/styles/index.css`: baseline element styles. They are wrapped in `:where()`, so any class overrides them. Every action in the app is a `Button`, `IconButton` or `LinkButton`; a bare `<button>` is only ever structural (a clickable row, a tab, a star, a disclosure). Its baseline is deliberately flat: a `--accent` background colour, the pill radius and no shadow, gradient or filter, so a page class that sets only `background-color` or `background: transparent` replaces it completely. Bare `h1` takes the headline role and bare `h2` the title role, so page titles and section heads are set in the thin display face; `h3` and below stay in the body face. `baselineStyles.test.ts` guards this, and `pageStyles.test.ts` keeps hex colours, small radii and heavy display weights out of page CSS.
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

The faces are Urbanist (display), Figtree (body and controls) and JetBrains Mono (paths, tag keys and diffs). They are Google Fonts, self-hosted through `@fontsource` so an offline homelab still gets them. The app never calls a font CDN. Urbanist is loaded in weights 200, 300 and 400 only. It reaches the page through `--type-display`, `--type-headline` and `--type-title`, which bare `h1` and `h2` use; a page class on an `h1` or `h2` therefore never sets a weight above 400, which would be a synthesised bold. Figtree is loaded from 400 to 700.

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

`tokenContrast.test.ts` uses the WCAG formula to check every ink-on-fill pair the primitives use, in both themes. Text pairs must reach 4.5:1 and focus rings (including the invalid-field outline and a ring over a selected row) and status dots must reach 3:1. Resting control borders are held above hairlines but below 3:1 on purpose: the field is identified by its fill, label and placeholder, and the focus ring carries the 3:1 guarantee. The same test checks that the two dark blocks (the OS setting and the explicit choice) are identical. Measured values differ slightly from the original specimen: `--ink-3`, `--ok` and `--warn` were darkened in light mode so that they pass on `--mist` and their tints.

**Themes.** Light is the default. The dark palette applies when the OS prefers dark, unless the viewer chose light, or whenever `data-theme="dark"` is set. Settings > Appearance has a System / Light / Dark switch (`ThemeSwitch`). The choice is stored in `localStorage` under the key `tagave-theme`, with every access guarded. An inline script in `index.html` applies the choice before first paint.

## Scale

- Space: `--space` is 4px, with steps of 4, 8, 12, 16, 20, 24, 32, 40, 48, 72 and 96px (`--space-xs` to `--space-4xl`).
- Radius: `--r-pill` for every control, `--r-card` 24px, `--r-cover` 18px, `--r-inner` 14px (textareas, thumbnails, notes) and `--r-kbd` 8px. No control is square or has a small radius.
- Controls: `--h-control` 48px, `--h-control-sm` 36px, `--h-chip` 30px. On coarse pointers a small control grows to 44px.
- Motion: `--dur-fast` 80ms (press), `--dur` 180ms, `--dur-slow` 280ms, `--ease-out`, `--ease-spring`, and `--dur-pop` 360ms with `--ease-pop`, the springy release of a pressed button's label.

## Buttons: the drop

`Button` takes `variant` (`primary | secondary | quiet | quiet-danger | danger`, where the older `ghost` is the same as `quiet`), `size` (`md | sm`), `icon`, and `loading`. The label is always rendered inside a child `<span>` so that it sits above the gloss layers. `IconButton` is a circular drop that needs a `label` for its accessible name. `LinkButton` takes the same props for navigation. Never put a link inside a button.

A drop is built from these layers, back to front:

1. A metallic rim: a 1.5px gradient border drawn with the `padding-box` / `border-box` double background.
2. The body gradient, with a glow rising from below.
3. A top inner highlight and a bottom inner shade.
4. A tinted drop shadow.
5. A specular sheen: a soft band over the top 30% that fades to nothing before the cap line of the label and fades out at both ends. Every glyph pixel therefore sits on the body colour, so labels keep 4.5:1 in both themes (measured on rendered pixels: 6.05:1 on the light primary, 5.57:1 on the dark one).

There is no discrete glint. The small white dot the first version put at the top-left read as a rendering bug.

The label `<span>` sets its own weight (Figtree 600), so a `<button>`, a `LinkButton` and a button with a page class all render the same.

States:

- The capsule never moves: no translate, no scale, no outer shadow growth on hover or press.
- Hover lights the surface: the sheen brightens a little, the rim picks up a thin inner glint and the depth inside deepens a touch.
- Press is an inset: over 80ms the inner shadow deepens, the sheen dims and the label sinks 1px inside the capsule. Letting go springs the label back past its place and settles (`--dur-pop`, `--ease-pop`). Quiet buttons sink their label the same way. Reduced motion keeps the light changes and drops the label movement.
- Focus shows a 2px `--ring` outline with a 3px offset.
- Disabled is desaturated at half opacity.
- Loading keeps the width and colour, swaps the label for a spinner (the label stays in the accessibility tree), sets `aria-busy` and blocks repeat presses.

Variants:

- **Primary:** the dew drop. Use at most one per view.
- **Secondary:** a clear frosted bubble.
- **Quiet:** text in `--dew` until touched.
- **Quiet danger:** the same text button in `--danger`, with a faint danger wash on hover. This is how a destructive trigger rests on a page (Delete, Stop, Discard); a two-press confirmation only changes its label.
- **Danger:** the full drop with the danger tint. It appears only as the final button of a confirm dialog (`tone: 'danger'`), never at rest on a page, so nothing red glows next to the primary.
- **Revert is not delete.** Undoing applied changes is a secondary bubble with the undo icon (`UndoIcon`), not a danger button.

`Button` defaults to `type="button"`. A form's submit button must set `type="submit"`. Labels are verbs in sentence case, one to three words.

Accessibility and fallbacks: reduced motion turns every transform off. Forced-colours mode switches to system `ButtonFace` / `ButtonText` with a 2px border and no gloss. Where `backdrop-filter` is unsupported, the secondary bubble falls back to an opaque surface.

## Other primitives

- **Input, Select, Textarea, TextField:** recessed pills, 48px tall (36px with `dense`), with a 1px `--control-border` (`--line-strong`) border and an inner shadow. Focus turns the border `--dew` and adds a 4px dew halo, and `:focus-visible` adds a solid 2px `--ring` outline (`--danger` when invalid). The outline is the indicator that must reach 3:1; the halo is decoration. `TextField` owns the label, ID, required marker, hint, error and `aria-describedby`. Its `previousValue` shows a pending change struck through, with a dew dot, for bulk tag editing. Leave `previousValue` undefined when there is no pending change. `null` (an absent tag), `''` and whitespace-only values read "(empty)", never nothing. Textareas use `--r-inner`. Checkboxes and radios stay native, with `accent-color`.
- **SearchField:** a search pill with a leading icon and a trailing `/` hint. It needs a `label` for its accessible name. Pressing `/` anywhere outside a text field focuses it.
- **Chip:** a 30px pill in Figtree 500 13px. With `onClick` it becomes a toggle button with `aria-pressed`. An `active` chip uses a dew tint with a deep dew label. `dot` adds a 6px status dot. Chips get no sheen.
- **Badge:** a quiet status pill. The state is written in words, and the colour appears only as a dot. `statusTone()` maps plan and job states to a tone.
- **Banner:** a flat tinted note (`--r-inner`) with a status dot. It explains an outcome or a condition the viewer can act on.
- **CoverArt, CoverChip:** every album cover (album grid and list, artist discography, Home, the album page) is a `CoverArt`: an intact square with `--r-cover` corners. Without art it draws a dew-tinted field, a thin groove mark and the title's initials in the display face; no emoji and no track count. State badges are `CoverChip`s: small frosted chips floating in a corner of the cover, with the state in words and a status dot. There is no strip across the bottom of the cover. `dimmed="missing"` fades and desaturates the art and adds a dashed rim; the chip stays at full strength.
- **Card, StatCard, Surface:** cards are opaque `--surface` with a 1px `--line` border, `--r-card` and a soft long shadow. They get no gloss and never nest for decoration. StatCard values are body-face, tabular data. `Surface variant="glass"` is only for layers that float over content: popovers, the sticky plan bar, toasts. Never put glass on glass or behind large scrolling areas.
- **Tabs:** a recessed pill track. The active tab is a clear bubble resting in it. There is one tab stop, and Left/Right (wrapping), Home and End move between tabs. Pass the real `panelId`. Tabs switch a local section; use navigation links to move between pages. On a narrow screen the track scrolls sideways: `useScrollFade` brings the current tab into view and fades whichever edge hides more tabs (`data-scroll-fade` in `index.css`), and the strip snaps to whole tabs, so a cut label reads as "more this way". Any other sideways strip (the album sections, the Settings sections on a phone) uses the same hook.
- **ConfirmDialog:** every confirmation goes through `confirmDialog({ title, message, confirmLabel, tone })`, which resolves true or false; `ConfirmHost` is mounted once at the root. It is a modal `<dialog>` labelled by its title and described by its message: the page behind is inert, Tab stays inside, Esc or a click on the backdrop cancels, and focus returns to the control that opened it. Focus starts on the confirm button, or on Cancel when `tone: 'danger'`. The title is a question, the confirm label is the verb ("Delete", "Apply changes"). Never call `window.confirm()` or `alert()`; a test guards this.
- **SegmentedControl / ThemeSwitch:** native radio buttons in the same pill track.
- **Tooltip:** a small glass label that opens on hover and focus. It closes on Escape, blur or pointer leave, can itself be hovered, and adds `aria-describedby` to its trigger. Use it only for supplementary text.
- **Table:** 44px rows with hairline dividers, no zebra stripes and `--mist` on hover. Column heads use the label style. Numbers are tabular. The table scrolls inside its own container on narrow screens.
- **Menu:** the "⋯" menu. A clear `IconButton` opens a glass list of actions (`role="menu"`); arrow keys, Home and End move, Escape or a click outside closes and focus returns to the trigger. It renders into `<body>` so no stacking context covers it, flips above the trigger when there is no room below, and on a phone (640px and below) becomes a sheet on the bottom edge over a soft scrim.
- **Collapse:** the accordion motion. A one-row grid whose track animates from `0fr` to `1fr` (240–260ms, ease-out) while the content fades in and settles 4px, so the content below is pushed smoothly and never jumps. Closed content is `inert`; children mount on first open; reduced motion switches instantly.
- **EmptyState:** a headline in the display face plus one sentence about the next useful step. Keep "nothing here" separate from "failed to load".

## Brand mark

The mark is an agave rosette resting in a dew-glass orb: a tall centre leaf, two rising leaves and two low ones on a small base. Its colours are the dew tokens, so it follows the theme like the primary button: a deep drop with a white plant in light mode and a lit drop with a dark plant in dark mode. It reads at 16px.

- App: `components/BrandMark.tsx`, inline SVG next to the live wordmark, hidden from assistive technology.
- Favicon: `public/tagave-mark.svg` switches palettes with `prefers-color-scheme`; `favicon-48.png` and a 180px `apple-touch-icon.png` (the light mark on the canvas colour) back it up.
- Landing page: one `<symbol>` in `site/index.html`, plus `site/img/mark.svg`, `favicon-48.png`, `apple-touch-icon.png` and `og.png`.

## Layout and motion

- Page gutters use `--page-pad`, which drops to 16px on phones. Every page must be free of horizontal scroll at 400px wide.
- The app shell is a sidebar on desktop, a wrapped bar on a tablet, and on a phone (720px and below) one 60px row: the mark, a search button and a menu button that opens the links and Sign out as a sheet (Esc closes it). The Discogs notice sits at the foot of the page content and scrolls with it; it never holds a strip of the screen.
- Detail pages (an album, an artist, a plan) trade the mark for a back button: on a phone it takes the mark's place in the bar, on wider screens it sits in a slim bar over the page. Back returns to where the viewer came from in the app, or to the parent list when the page was opened cold. The page's title fades into the bar once its own heading scrolls under it.
- Tables with more than three columns turn into stacked rows on a phone rather than squeezing the main column. The album track list is not a table: it is a player's list (number, title with the artist under it only when it differs, length), 56px rows on a phone.

## Maintenance

Maintenance is an app-wide mode (the wrench toggle in the bar, Settings › Appearance, or Shift+M; remembered per browser in `localStorage` under `tagave-maintenance`). Off is the default: pages show the music, and an album speaks up only when a real discrepancy needs a decision (needs review, a likely split album, an owner request that failed, a task that got resolved). On, the curation layer appears: the album's state chip and provider links, every library issue in the attention strip, the Manage menu, per-track marks and missing tracks in the list, quality badges on album covers, and provider links, refresh and skipped releases on artist pages. `utils/albumAttention.ts` holds the rules and is tested.
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

Every page uses this system: navigation, Home, the album grid and album page, artists, search, Library care, tag changes and the plan wizard, background activity, every settings section, setup, onboarding and sign-in. Some page CSS still uses the legacy token names; they resolve to the palette, so rename them when you touch a rule. When you add or change a page:

1. Use the primitives for every action: one primary drop per view, clear bubbles for the rest, quiet text buttons for dismiss and cancel. Destructive triggers are quiet danger text; the red drop lives only in the confirm dialog.
2. Filters and suggestions are chips (surface to mist, the active one dew-tinted). In the album filter rail every row is checkbox, left-aligned label, then the count flush right in tabular figures, and a row shows a tooltip only when its label is cut off; fields take the global recessed pill, so a page class only sizes them.
3. Floating layers (search, the review decision bar, toasts, the wizard footer) are glass; cards and tables stay opaque and flat.
4. Use tokens for every colour. No hex, `white` or `rgba(0,0,0,…)` in page CSS.

Extract a new pattern into `components/ui` only after it has at least three comparable uses, and add each new variant to the catalogue.

## Validation

Run web type checking, the Vite build and Vitest for `@liner/web`. The contrast and primitive-contract tests live in `components/ui`. In the catalogue, at desktop width and at 400px, in both themes, check:

- the button states: hover, press, focus, disabled, loading
- field validation
- tab arrow keys
- tooltips with the keyboard
