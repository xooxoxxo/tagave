# Features

tagave is a catalog brain for a large music archive. It identifies every album against MusicBrainz and Discogs, shows gaps in your collection, and keeps track of what you own.

## Artist pages

Every artist linked to your library's albums has a profile showing their name, type (Person, Group, …), country, years active, and a biography excerpt from Wikipedia with full attribution and a link to the full article (CC BY-SA 4.0). Click any artist name to browse their discography as it appears in your library, grouped by type (Album, EP, Single, Live, Compilation, Other). Each release shows what you own: digital, physical, or both. Toggle **Follow** to curate your own artist list.

## Genres

Each album is tagged with effective genres (up to three) computed from Discogs and MusicBrainz data and weighted to surface the most relevant: top genres appear as chips, secondary styles as muted tags. Go to **Settings › Genres** to customize the genre taxonomy: edit the whitelist (default: Rock, Electronic, Pop, Jazz, 13 more), add aliases to map niche styles to top-level categories (e.g., black metal → Metal), and adjust the maximum number of genres per album.

## Identification

tagave identifies albums against MusicBrainz and Discogs by matching metadata, cover art, and acoustic fingerprints. When a file's tags are wrong or missing, acoustic fingerprinting can identify it anyway. The matcher finds the exact pressing you have, not just the album, and handles multi-disc sets by pairing discs and working from disc numbers.

## Review queue

When identification finds ambiguous matches, they land in the review queue. You decide which one is correct using keyboard shortcuts, and the choice is recorded with the metadata so the same album will match correctly if scanned again.

## Gaps

tagave shows incomplete albums (missing tracks), duplicates (the same album in different formats or editions), and missing releases by artists you follow. Finding these gaps helps you know what to look for on your next record hunt.

## Physical collection

Sync your physical collection with Discogs so your shelf and your files are one catalogue. When you own an album both digitally and on vinyl, it appears in the library as owned in both formats.

## Tag correction

tagave safely corrects tags in your music files using metadata from MusicBrainz and Discogs. The workflow is journaled and fully revertible: preview the changes before applying them, or revert to the old tags later. You can lock specific fields on an album to keep your custom values, and the locks survive reverts and are respected by future corrections.
