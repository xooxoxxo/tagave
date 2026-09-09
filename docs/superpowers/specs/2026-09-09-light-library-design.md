# Liner: a spacious music library

## Approved direction

Make Liner a light, editorial music library inspired by the spaciousness and music focus of Roon. Preserve the existing React, TanStack Router, React Query, and CSS Modules stack. Keep current API behavior, authentication, and library operations.

## Visual system

Use warm white page backgrounds, white primary surfaces, charcoal text, and a restrained deep teal accent. Always use this light palette regardless of system appearance. Define semantic tokens for surface, text, border, accent, success, warning, and error, including readable secondary text and visible keyboard focus. Use a consistent sans-serif type scale with large page headings, smaller section headings, and tabular numerals for counts. Set responsive page gutters, consistent control heights, spacing, corner radii, and restrained transitions. Respect reduced motion.

Shared buttons, inputs, cards, tabs, tables, banners, and empty states should use those tokens. Reserve filled accent buttons for primary actions; use neutral controls for secondary actions. Artwork supplies most of the color. Avoid decorative dashboard cards and repeated enclosing borders.

## Application navigation

Retain existing URLs and deep links. Organize navigation into music destinations (Home, Albums, Artists, Physical collection), maintenance destinations (Library care, Tag changes), and Settings. Library care maps to /work; Tag changes maps to /plans. Make active destinations explicit, including detail pages. Keep global search readily available with its keyboard shortcut. Use responsive navigation that does not consume most of a narrow viewport. Include a skip-to-content link and working sign-out behavior.

The shell should provide one clear scrolling region for ordinary pages. The legal attribution belongs at the end of content instead of occupying a fixed strip of viewport height. Preserve bounded scrolling where virtualization requires it.

## Home

Lead with a welcoming library heading and recent additions using existing album data and artwork. Each album opens its detail page. Provide a clear route to all albums. Below that, summarize library care and recent tag changes. Distinguish unavailable data from zero counts; provide loading, retryable error, and first-library empty states. Avoid unsupported recommendations or playback controls.

## Albums and artists

Separate page identity, search/sort/view controls, filters, and results. Preserve album URL filters, sorting, pagination, selection, and virtualization. Use comfortably sized artwork and readable metadata with responsive grids. Show active filter state and a clear reset action. Keep bulk actions contextual to selection. Artists and physical collection follow the same page hierarchy and control styling.

## Detail pages

Give album artwork, title, artist, and release metadata a clear visual hierarchy. Keep track listings legible and multi-disc grouping intact. Group maintenance operations separately from music information using existing disclosure controls where possible. Preserve identification, ratings, reviews, tag changes, and navigation to related entities. Avoid nested clickable controls and provide labels for icon-only actions.

## Library care and tag changes

Explain what each destination does in plain language. Retain the review, identify, and attention workflows, with clearer tab labels and meaningful counts. Use one page heading rather than nested full-page headers. Show action progress, success, and recoverable failures near the action. Preserve confirmation and preview behavior for file-writing operations.

## Settings

Replace stacked multi-tool pages with focused navigation to library sources, metadata/tag preferences, follow rules, integrations, and system activity. Preserve existing settings links by resolving legacy sections to their equivalent destination. Each panel should have one heading, a short explanation, and its own save/status feedback. Avoid nesting entire page shells inside settings sections.

## Implementation sequence

1. Shared tokens, primitives, application shell, responsive navigation, and sign-out correctness.
2. Music-first Home and browsing hierarchy for albums, artists, and collection.
3. Detail-page hierarchy and maintenance organization.
4. Focused Settings and consistent library-care/tag-change naming.
5. Verify responsive layouts, keyboard interactions, async states, and existing workflows.

## Validation

Run web type checking, production build, and existing web tests. Add focused behavior tests only for changed navigation or interaction logic. Inspect rendered desktop and narrow layouts with populated, empty, loading, and failed requests where feasible. Check search open/close, navigation and browser history, filters and reset, detail links, settings navigation, and sign-out. Report any backend-dependent behavior that cannot be exercised locally.

## Scope boundaries

No framework migration, backend redesign, fabricated music data, new playback engine, or changes to metadata matching algorithms. Reuse actual artwork and existing API responses. Any unavailable backend data must be represented honestly in the UI.
