<div align="center">

<img src="docs/images/mark.png" alt="" width="88" />

# tagave

A self-hosted catalogue for the music you own.

[Website](https://tagave.app) · [Install](docs/install.md) · [Docs](docs/) · [Changelog](CHANGELOG.md)

<br />

<img src="docs/images/albums.jpg" alt="The tagave album grid: cover art with artist, format, track count and year under each album" />

</div>

<br />

## What it does

- **Knows every album.** Matches each one against MusicBrainz and Discogs, down to the pressing.
- **Fixes tags safely.** You preview every change, and any change can be undone. Files are never moved or converted.
- **Shows what's missing.** Incomplete albums, duplicates, and new releases by artists you follow.
- **Includes your shelf.** Sync your Discogs collection, and your vinyl and CDs sit next to your files.
- **Plays, if you want.** An optional player, shared with your household, with scrobbling for each person.

## Install

You need Docker with Compose 2.20 or later.

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh)"
```

Then open <http://localhost:3100>. The [install guide](docs/install.md) covers music on another computer, building from source, and the player.

## Status

Early. It runs one real library of 27,000 albums every day. Read [Operations](docs/operations.md) before you trust it with files you can't replace.

## Licence

[AGPL-3.0](LICENSE). The tag writer runs [mutagen](https://github.com/quodlibet/mutagen) as a separate process ([notices](THIRD-PARTY-NOTICES.md)).

Metadata comes from [MusicBrainz](https://musicbrainz.org) and [Discogs](https://www.discogs.com). This application uses Discogs' API but is not affiliated with, sponsored or endorsed by Discogs. 'Discogs' is a trademark of Zink Media, LLC.
