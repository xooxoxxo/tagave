# Changelog

Every release of tagave, newest first. Assembled from [`release-notes/`](release-notes/) by `node scripts/release-notes.mjs --changelog`; edit the notes there, not here.

## [v0.25.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.25.0)

**Minor release (0.24 → 0.25).** An equalizer glow that flows with the music, a clearer "Playing on" strip that opens your devices, and a new tagave.app.

### Before you update

- **Nothing to do.** No database change in this release.

### New

- **A new tagave.app.** The six highlights come first, then a section for each area: identify, tag, organize, collect, listen and DJ. The questions are updated for the player, file moves and Lidarr. ([e7c008b](https://github.com/xooxoxxo/tagave/commit/e7c008b))

### Fixed

- **The equalizer glow flows.** It is one soft wash of light that swells with the music, never separate bars. The light drifts slowly, so it keeps moving on a held note. ([41f23b9](https://github.com/xooxoxxo/tagave/commit/41f23b9))
- **"Playing on …" sits above the player bar.** It is a thin band in the accent colour, with its text centred, and the bar keeps its height. Select it to open your devices. ([41f23b9](https://github.com/xooxoxxo/tagave/commit/41f23b9))

**All changes:** [v0.24.0...v0.25.0](https://github.com/xooxoxxo/tagave/compare/v0.24.0...v0.25.0)

## [v0.24.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.24.0) (2026-11-05)

**Minor release (0.23 → 0.24).** A DJ add-on: Simple mode mixes your queue by itself, Advanced mode gives you two decks to mix.

### Before you update

- **Going back to 0.23 means a restore.** This update changes the database (migrations 0086 and 0087). The updater takes a backup first and restores it on its own if the update fails; to return to 0.23 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.24.0/docs/operations.md).
- **DJ is off until you turn it on** in Settings › Modules › DJ. Off, the player works exactly as before.

### New

- **DJ module.** Once on, tagave measures each song's tempo, first beat, silent start and end, and waveform in the background, one at a time, songs in a queue first. Nothing leaves your server; a re-tag doesn't measure again. ([e4f8392](https://github.com/xooxoxxo/tagave/commit/e4f8392), [e4ee5dd](https://github.com/xooxoxxo/tagave/commit/e4ee5dd), [926f2f5](https://github.com/xooxoxxo/tagave/commit/926f2f5), [cb2d001](https://github.com/xooxoxxo/tagave/commit/cb2d001))
- **Simple mode: the queue mixes itself.** Per person in Settings › Modules › DJ: Crossfade Off / Fixed / Auto, Length, Beat-aligned and Gapless albums. Auto fades where the music ends and brings the next song in where it starts; Beat-aligned lands the fade on the beat and starts the next song at the current tempo, easing back to its own over 8 bars. Songs of one album keep playing gapless. A "Mix" chip shows in the bar during a fade. ([b4f5954](https://github.com/xooxoxxo/tagave/commit/b4f5954), [cc39766](https://github.com/xooxoxxo/tagave/commit/cc39766), [ce811b5](https://github.com/xooxoxxo/tagave/commit/ce811b5), [0c5edbf](https://github.com/xooxoxxo/tagave/commit/0c5edbf))
- **Advanced mode: two decks.** The DJ key in Now playing (or `/dj` in ⌘K) opens two decks with a waveform, BPM, Play, Cue, Pitch and Sync, a Filter, a 3-band EQ with kills and Echo on each, and a crossfader. The next song loads into the free deck by itself, and Auto mix does the transitions for you. What you hear is your Now playing, scrobbles included; leaving the view hands the playing song back to the player. ([5d1f659](https://github.com/xooxoxxo/tagave/commit/5d1f659), [ac89017](https://github.com/xooxoxxo/tagave/commit/ac89017), [0fdb1f5](https://github.com/xooxoxxo/tagave/commit/0fdb1f5), [a5c8fee](https://github.com/xooxoxxo/tagave/commit/a5c8fee))

### Known limits

- **Not in the home-screen app on iPhone or iPad,** where mixing would stop music playing in the background; it says "Not on this device".
- **Not while casting** or while another of your devices plays: the device that plays decides.

### For self-hosters

- **Migrations:** 0086 (DJ track analysis), 0087 (DJ settings per person).
- **The files worker** measures songs with ffmpeg at low priority, one at a time, while the DJ module is on.

**All changes:** [v0.23.0...v0.24.0](https://github.com/xooxoxxo/tagave/compare/v0.23.0...v0.24.0)

## [v0.23.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.23.0) (2026-11-04)

**Minor release (0.22 → 0.23).** Like songs, albums and artists, with Liked songs and Liked filters, kept in step with your player's stars.

### Before you update

- **Going back to 0.22 means a restore.** This update changes the database (migration 0085). The updater takes a backup first and restores it on its own if the update fails; to return to 0.22 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.23.0/docs/operations.md).
- **Your player's stars become likes.** With the player module on and your own player account, the first sync brings the songs, albums and artists you starred in Subsonic apps in as likes, and your likes go out as stars. Tracks your reviews marked as favourites are starred already, so they arrive as liked songs too.

### New

- **Likes.** A heart on the player bar, Now playing, song rows, every song menu, the album header, album cards and the artist header. Albums are liked as the release, so every edition shows as liked; liked songs survive a rescan, Move to album and Split. ([dad4e81](https://github.com/xooxoxxo/tagave/commit/dad4e81), [115ad55](https://github.com/xooxoxxo/tagave/commit/115ad55), [227b31f](https://github.com/xooxoxxo/tagave/commit/227b31f))
- **Liked songs:** in the sidebar, the phone menu and first on Playlists, newest first, with Play and Shuffle. ([115ad55](https://github.com/xooxoxxo/tagave/commit/115ad55))
- **Liked filter** on Albums and Artists, working with every other filter and saved views; liked results carry a small heart in ⌘K. ([115ad55](https://github.com/xooxoxxo/tagave/commit/115ad55))
- **Stars and loves.** Likes and your player's stars stay in step both ways (the newer change wins), so Subsonic apps show the same hearts. A liked song is sent as a love to Last.fm and ListenBrainz; Settings › Modules › Player › Loves turns that off per account. ([dad4e81](https://github.com/xooxoxxo/tagave/commit/dad4e81))

### Improved

- **Turning a module off** asks with an Off | On "Delete its data" and a "Kept · …" or "Deleted · …" line; the key turns red only when it will delete. ([5c34823](https://github.com/xooxoxxo/tagave/commit/5c34823))
- **Settings › Updates** says "Updating" while an update settles and "Older build" after, instead of "lagging". ([267f027](https://github.com/xooxoxxo/tagave/commit/267f027))
- **The selected pill** of switches and tabs has the same edge all round. ([e7a78ef](https://github.com/xooxoxxo/tagave/commit/e7a78ef))

### For self-hosters

- **Migrations:** 0085 (likes).
- **Outside services:** with a scrobbling account linked, a liked or unliked song is sent as a love to Last.fm (`track.love`) and as feedback to ListenBrainz.

**All changes:** [v0.22.0...v0.23.0](https://github.com/xooxoxxo/tagave/compare/v0.22.0...v0.23.0)

## [v0.22.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.22.0) (2026-11-04)

**Minor release (0.21 → 0.22).** Albums land where your naming rules say, a drop pool brings downloads in, music plays in one place across your devices, ⌘K learns scopes and commands, and artist pages show similar artists.

### Before you update

- **Going back to 0.21 means a restore.** This update changes the database (migrations 0081 and 0084). The updater takes a backup first and restores it on its own if the update fails; to return to 0.21 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.22.0/docs/operations.md).
- **The page search is a ⌘K chip.** Type `@artist`, `@album` or `@song` to narrow, or `/` for commands.

### New

- **Naming rules.** Settings › Library › Naming holds a folder and a file template, read from your library the first time (for example `{initial}/{albumartist}/[{year} - ]{album}` and `[{disc}-][{track:02} - ]{title}`), with rows for soundtracks and compilations and a Leave alone list (by default folders starting with `#`, and `_duplicates`). A tag plan shows each file's new path; Apply writes the tags, then moves the album and its covers, cue and logs, never over a file. Reverting the plan undoes the move. Library care › Organize lists albums in the wrong folder or with the wrong names. ([3f25e0c](https://github.com/xooxoxxo/tagave/commit/3f25e0c), [a7b24ab](https://github.com/xooxoxxo/tagave/commit/a7b24ab), [1d7ff55](https://github.com/xooxoxxo/tagave/commit/1d7ff55), [03472b3](https://github.com/xooxoxxo/tagave/commit/03472b3), [4373751](https://github.com/xooxoxxo/tagave/commit/4373751), [95b0bb9](https://github.com/xooxoxxo/tagave/commit/95b0bb9), [f76a2c0](https://github.com/xooxoxxo/tagave/commit/f76a2c0))
- **Drop pool.** Turn it on in Settings › Library and drop album folders into it (by default `_Inbox` in your music folder). Once a folder has stopped changing for 2 minutes, tagave identifies it: a confident match is tagged and moved to its rule path; anything else waits in Library care › Inbox with Accept, Pick release… and Skip. An album you already have asks Replace, Keep both or Skip. Lidarr can download into the pool. ([03472b3](https://github.com/xooxoxxo/tagave/commit/03472b3), [4c4ce4c](https://github.com/xooxoxxo/tagave/commit/4c4ce4c))
- **Play in one place.** Pressing play on one of your devices quiets the others, which show "Playing on <device>" and control it: play, pause, skip, seek and volume. The Devices key moves playback to another device or brings it here. Strictly per person. ([84832c8](https://github.com/xooxoxxo/tagave/commit/84832c8), [8775eda](https://github.com/xooxoxxo/tagave/commit/8775eda), [43d92da](https://github.com/xooxoxxo/tagave/commit/43d92da))
- **Similar artists** on the artist page, from ListenBrainz (and Last.fm when a key is set): those in your library first, to open and play; the rest with Listen elsewhere and Follow. Only artist MusicBrainz ids leave your server; Settings › Modules turns it off. ([0d738f7](https://github.com/xooxoxxo/tagave/commit/0d738f7), [3cbdd16](https://github.com/xooxoxxo/tagave/commit/3cbdd16), [4ba410d](https://github.com/xooxoxxo/tagave/commit/4ba410d), [a6751da](https://github.com/xooxoxxo/tagave/commit/a6751da))

### Improved

- **⌘K:** `@artist`, `@album`, `@song`, `@playlist` and `@label` narrow the results to one kind as a chip; `/play`, `/queue`, `/shuffle`, `/go` and `/theme` act on the highlighted result. ([0ecbdc4](https://github.com/xooxoxxo/tagave/commit/0ecbdc4), [0d4016f](https://github.com/xooxoxxo/tagave/commit/0d4016f))
- **Back keeps your place:** scroll, letter, sort, filters and view on Albums, Artists, an artist's albums and Playlists. ([847183f](https://github.com/xooxoxxo/tagave/commit/847183f))
- **Deleting the album or playlist you're on** goes back to where you came from; Undo still works. ([2dac7d2](https://github.com/xooxoxxo/tagave/commit/2dac7d2))
- **Artist page:** a three-line bio up top; other names, dates and links move to About, below the albums. ([cd3c0e8](https://github.com/xooxoxxo/tagave/commit/cd3c0e8))

### Fixed

- **Cast links** accept only the exact spelling of their signature. ([0f8aa2b](https://github.com/xooxoxxo/tagave/commit/0f8aa2b))

### For self-hosters

- **Migrations:** 0081 (move kinds, plan paths, drop pool), 0084 (similar artists).
- **Outside services:** similar artists asks ListenBrainz (and Last.fm with your key) by artist MusicBrainz id, about once a second at most, refreshed weekly.
- **A drop pool on its own mount** needs a compose change; see the docs.

**All changes:** [v0.21.0...v0.22.0](https://github.com/xooxoxxo/tagave/compare/v0.21.0...v0.22.0)

## [v0.21.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.21.0) (2026-11-04)

**Minor release (0.20 → 0.21).** Collaborative playlists, casting to speakers and TVs, moving songs into the right album's folder, splitting a whole album that sits in one FLAC, and a new equalizer glow.

### Before you update

- **Going back to 0.20 means a restore.** This update changes the database (migrations 0078, 0079 and 0080). The updater takes a backup first and restores it on its own if the update fails; to return to 0.20 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.21.0/docs/operations.md).
- **Delete moves to Maintenance.** Song and album Delete no longer show in everyday menus; turn on Maintenance on an album to delete.
- **Casting to a Chromecast needs `PUBLIC_URL` on https with a publicly trusted certificate**; AirPlay also plays from plain http. See [Cast to a speaker or TV](https://github.com/xooxoxxo/tagave/blob/v0.21.0/docs/install.md).

### New

- **Move songs to another album.** In an album's Maintenance, select songs and Move to album…: pick an album in your library or a release you don't have yet. The preview pairs each song with its track on the target (with a match %), shows its new name in the target's folder and its tag changes. Move writes the tags, then moves the files without ever overwriting; a folder left empty goes to the trash. Undo puts back names and tags, right away or later from Library care › Moved. Needs a music folder tagave may write to. ([a30541d](https://github.com/xooxoxxo/tagave/commit/a30541d), [379dbc3](https://github.com/xooxoxxo/tagave/commit/379dbc3), [1f9993e](https://github.com/xooxoxxo/tagave/commit/1f9993e), [833939f](https://github.com/xooxoxxo/tagave/commit/833939f), [ec6f05e](https://github.com/xooxoxxo/tagave/commit/ec6f05e), [882b308](https://github.com/xooxoxxo/tagave/commit/882b308))
- **Collaborative playlists.** A playlist's ⋮ › Collaborators turns people on or off. Collaborators play, add and reorder, and remove what they added; the owner keeps rename, delete and who collaborates. Each song shows who added it, and shared playlists carry a small people mark. ([b467eed](https://github.com/xooxoxxo/tagave/commit/b467eed), [73b0bcf](https://github.com/xooxoxxo/tagave/commit/73b0bcf), [f6c7ad0](https://github.com/xooxoxxo/tagave/commit/f6c7ad0))
- **Cast to speakers and TVs.** One cast key in the player: AirPlay in Safari, Chromecast from Chrome on a computer or Android. Play, pause, seek, volume and the queue carry on from the bar; the TV shows title, artist and cover. ([ff6b144](https://github.com/xooxoxxo/tagave/commit/ff6b144), [b8d76d1](https://github.com/xooxoxxo/tagave/commit/b8d76d1))
- **Split a whole album in one file.** A FLAC holding a whole album without a cue sheet shows as "Whole album in one file" in Library care › Attention and on its album page. Split finds the cut between each track (track lengths from the release, moved to the nearest quiet gap, each rated High, Medium or Low), then writes one tagged FLAC per track, losslessly, and checks every sample is accounted for before the original goes to the trash (Restore puts it back). ([d1dd44a](https://github.com/xooxoxxo/tagave/commit/d1dd44a), [3d9c76a](https://github.com/xooxoxxo/tagave/commit/3d9c76a), [7998b86](https://github.com/xooxoxxo/tagave/commit/7998b86), [d73a451](https://github.com/xooxoxxo/tagave/commit/d73a451), [97cff36](https://github.com/xooxoxxo/tagave/commit/97cff36), [1edb0d3](https://github.com/xooxoxxo/tagave/commit/1edb0d3))

### Improved

- **The equalizer glow is a live spectrum.** 32 columns, bass to treble, rise above the player bar's edge in the album's colour, from the right side on a desktop and across the mini bar on a phone. It goes fully dark when paused, stopped or casting. ([a6d042a](https://github.com/xooxoxxo/tagave/commit/a6d042a), [3a6d81e](https://github.com/xooxoxxo/tagave/commit/3a6d81e))
- **One song menu everywhere:** Play next, Add to queue, Add to playlist, Go to album and Go to artist on album tracklists, playlists, Now playing, the queue, history, search results and Library care's track lists. ([4c74cc7](https://github.com/xooxoxxo/tagave/commit/4c74cc7), [7bc766a](https://github.com/xooxoxxo/tagave/commit/7bc766a))
- **Delete only in Maintenance:** select songs to delete them, all of them to delete the album, with Undo; album cards and Duplicates show Delete only in Maintenance. ([7bc766a](https://github.com/xooxoxxo/tagave/commit/7bc766a))

### Fixed

- **Switch and tab labels sit in the middle.** The small ones (Light/Dark/Auto, Grid/List) sat about half a pixel low, and every label sat about a pixel high in browsers without text trimming. ([54a60f2](https://github.com/xooxoxxo/tagave/commit/54a60f2))

### For self-hosters

- **Migrations:** 0078 (album splits), 0079 (playlist collaborators), 0080 (album moves).
- **The worker image now includes `flac`** (about 0.5 MB), used to split albums.
- **Cast links:** a cast device fetches a signed link to one track (and its cover), valid for 6 hours and bound to the person; tokens never appear in logs.

**All changes:** [v0.20.0...v0.21.0](https://github.com/xooxoxxo/tagave/compare/v0.20.0...v0.21.0)

## [v0.20.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.20.0) (2026-11-04)

**Minor release (0.19 → 0.20).** Every module's settings in one place, and a music folder that drops out is noticed and reconnected.

### Before you update

- **Nothing to do.** No database changes. Old settings links (Connections, Listen elsewhere, Playback, Listening) redirect to their new pages.

### New

- **A music folder that didn't mount is reconnected.** When a scan finds the music folder empty because its network share didn't mount (for example after a reboot), the updater starts that folder's own `/etc/fstab` mount and restarts tagave's music containers, at most once every 10 minutes. It never unmounts or edits anything. Turn it off with `TAGAVE_MUSIC_SELF_HEAL=0` in `.env`. See [A music folder that did not mount](https://github.com/xooxoxxo/tagave/blob/v0.20.0/docs/operations.md). ([9490611](https://github.com/xooxoxxo/tagave/commit/9490611), [fa1c0b3](https://github.com/xooxoxxo/tagave/commit/fa1c0b3))
- **"Music folder unreachable"** shows to the owner on every page while a music folder can't be read, and "Reconnecting music folder" while it is being fixed. Nothing is marked missing meanwhile. ([9875119](https://github.com/xooxoxxo/tagave/commit/9875119))

### Improved

- **Settings › Modules holds every module's settings.** One row per module (Player, Lidarr, Listen elsewhere, Music Connections, Playlists) with On/Off; each opens one page with its switch and all its settings. Playback, Listening, Listen elsewhere and Connections leave the sidebar. Members see Modules under Account, with the modules that have something for them. ([fb140e7](https://github.com/xooxoxxo/tagave/commit/fb140e7), [71984ce](https://github.com/xooxoxxo/tagave/commit/71984ce), [efa4599](https://github.com/xooxoxxo/tagave/commit/efa4599))

### For self-hosters

- **Settings in `.env.example`:** added `TAGAVE_MUSIC_SELF_HEAL` (on unless set to `0`).
- **The updater may start one helper container** (`tagave-music-heal`, its own image, `--privileged --pid=host`) to start the music folder's mount on the host; it runs only for the folder in `MUSIC_DIR` and only when that folder is an `/etc/fstab` mount.

**All changes:** [v0.19.0...v0.20.0](https://github.com/xooxoxxo/tagave/compare/v0.19.0...v0.20.0)

## [v0.19.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.19.0) (2026-11-04)

**Minor release (0.18 → 0.19).** Tag plans pair every file with the right release track again, and phones get a compact layout with one search.

### Before you update

- **Going back to 0.18 means a restore.** This update changes the database (migration 0077). The updater takes a backup first and restores it on its own if the update fails; to return to 0.18 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.19.0/docs/operations.md).
- **Previewed tag plans go back to draft.** Their previews may pair files with the wrong release tracks; opening a plan previews it again with the repaired pairing.

### Fixed

- **Files paired with the wrong release track.** When an album's files were stored out of track order, each file's track link landed on another file, so a tag plan could write another song's title, track number and recording id. Links now land on the file they were worked out for, and the update relinks every album in the background. A paused plan's unwritten files are skipped. Files an earlier plan already wrote keep their tags; a new plan on that album shows the corrections. ([47f9efe](https://github.com/xooxoxxo/tagave/commit/47f9efe), [d75ac8e](https://github.com/xooxoxxo/tagave/commit/d75ac8e), [c167083](https://github.com/xooxoxxo/tagave/commit/c167083))
- **Files that aren't on the release are left out of tag plans** ("Not on this release"), instead of getting that album's tags. A weak match only counts when the file's track number agrees. ([f98d420](https://github.com/xooxoxxo/tagave/commit/f98d420), [c167083](https://github.com/xooxoxxo/tagave/commit/c167083))
- **Missing-album cards keep their spacing** when Lidarr is off or no main service is picked. ([089e2ee](https://github.com/xooxoxxo/tagave/commit/089e2ee))

### Improved

- **Tag plans show each file's release track and match**, e.g. `1 · Clouds · 100%`; a weak match shows in amber. ([9f917b2](https://github.com/xooxoxxo/tagave/commit/9f917b2), [269c656](https://github.com/xooxoxxo/tagave/commit/269c656))
- **One search.** The search field on Albums and Artists is gone; the header search shows "In albums" (or "In artists") first, and Enter narrows the list, shown as a chip. ([c55af2a](https://github.com/xooxoxxo/tagave/commit/c55af2a))
- **List toolbar:** the count, then Sort, Filter (with how many are on) and Grid/List keys in one row. Filters open as a bottom sheet on phones; chips show only while a filter is on. ([97a8f83](https://github.com/xooxoxxo/tagave/commit/97a8f83))
- **Compact phones.** Albums start about 140px higher; no empty band above the player bar; the menu is a full-height sheet; the artist header is tighter; album checkboxes show only while selecting (hold an album to start). ([04aa93e](https://github.com/xooxoxxo/tagave/commit/04aa93e), [1617306](https://github.com/xooxoxxo/tagave/commit/1617306), [033cd8e](https://github.com/xooxoxxo/tagave/commit/033cd8e))

### For self-hosters

- **Migrations:** 0077 (relink tracks; plan items carry their pairing).

**All changes:** [v0.18.0...v0.19.0](https://github.com/xooxoxxo/tagave/compare/v0.18.0...v0.19.0)

## [v0.18.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.18.0) (2026-11-03)

**Minor release (0.17 → 0.18).** Get missing albums through Lidarr, and play what is still missing on your own streaming service.

### Before you update

- **Going back to 0.17 means a restore.** This update changes the database (migrations 0075–0076). The updater takes a backup first and restores it on its own if the update fails; to return to 0.17 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.18.0/docs/operations.md).

### New

- **Get missing albums through Lidarr.** Turn on Lidarr in Settings › Modules, then connect it in Settings › Connections › Lidarr (address, API key, Test, then root folder and profiles). On an artist page, a missing album's ⋮ menu has Get, and the "Not in your library" heading has Get all missing. Lidarr monitors and searches only that album, never the whole discography. Each album shows Wanted, Downloading, Importing or Not found; when Lidarr imports it, tagave scans that folder at once and the album joins your library. Library care › Getting lists open requests with Retry and Cancel; Cancel stops the search and never deletes files. Owner only. See [Get missing albums](https://github.com/xooxoxxo/tagave/blob/v0.18.0/docs/install.md). ([db09110](https://github.com/xooxoxxo/tagave/commit/db09110), [c6d1b16](https://github.com/xooxoxxo/tagave/commit/c6d1b16))
- **Play missing albums on your service.** Settings › Listen elsewhere › Missing albums picks one service; missing albums and missing playlist songs then get a ▶ key that opens them there. ([1f29ac9](https://github.com/xooxoxxo/tagave/commit/1f29ac9), [2d83ca0](https://github.com/xooxoxxo/tagave/commit/2d83ca0))

### For self-hosters

- **Migrations:** 0075 (Lidarr requests), 0076 (primary listen service).
- **Lidarr's root folder must be one of tagave's scan roots** (the same folder, mounted in both), or tagave can't pick up what Lidarr imports; Settings › Connections › Lidarr warns when it isn't.

**All changes:** [v0.17.0...v0.18.0](https://github.com/xooxoxxo/tagave/compare/v0.17.0...v0.18.0)

## [v0.17.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.17.0) (2026-11-02)

**Minor release (0.16 → 0.17).** Delete songs and albums, by marking them or moving them to a trash, and sign in with your own login service, such as Zitadel.

### Before you update

- **Going back to 0.16 means a restore.** This update changes the database (migrations 0073 and 0074). The updater takes a backup first and restores it on its own if the update fails; to return to 0.16 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.17.0/docs/operations.md).
- **Split installs** (a files worker on another machine): update that worker too, so it learns where your music folder is on that machine.

### New

- **Delete songs and albums.** Settings › Library › Deleting picks one mode, and every ⋯ menu shows only that one: on a song, an album, an album card, and each copy in an album's Duplicates. An Undo shows for 5 seconds first. ([e7a8384](https://github.com/xooxoxxo/tagave/commit/e7a8384), [918395f](https://github.com/xooxoxxo/tagave/commit/918395f))
  - **Mark** (any install): the song or album leaves the library, search and the player at once; your music files are not touched. Library care › Deleting lists what is marked, with Unmark and a command that deletes exactly those files on your server.
  - **Trash** (music folders tagave may write to): the files move to a hidden `.tagave-trash` folder in the music folder, which the player skips. Restore puts them back; Empty trash deletes them, and trash older than 30 days empties itself.
  - Plays, ratings and matches stay until the files are really gone, so Unmark and Restore lose nothing.
- **Sign in with your login service.** Zitadel, Authentik, Authelia, Keycloak, Pocket ID or any OpenID Connect service: set it up in Settings › Users › Sign-in service and a "Sign in with …" button joins password and passkey. People link it from Account; new people come by invite, or join on their own if you allow it, optionally only from one group. The owner always keeps a password or passkey, and an authenticator app still asks for its code. See [Sign in with your login service](https://github.com/xooxoxxo/tagave/blob/v0.17.0/docs/security.md). ([1bb941d](https://github.com/xooxoxxo/tagave/commit/1bb941d), [8970e87](https://github.com/xooxoxxo/tagave/commit/8970e87), [9ff99ac](https://github.com/xooxoxxo/tagave/commit/9ff99ac), [26db84c](https://github.com/xooxoxxo/tagave/commit/26db84c), [feff76f](https://github.com/xooxoxxo/tagave/commit/feff76f), [8d6f7e1](https://github.com/xooxoxxo/tagave/commit/8d6f7e1))

### Improved

- **Removing the last passkey** of an account with no password is refused unless another way in remains; an owner's last passkey can't be removed.

### For self-hosters

- **Migrations:** 0073 (file deletions), 0074 (login service sign-in).
- **Compose:** the files worker now gets `TAGAVE_MUSIC_HOST_DIR: ${MUSIC_DIR}`, so the delete command shows paths as they are on your server. The updater brings the new compose file; if you keep your own compose file, add that line to the files worker.

**All changes:** [v0.16.0...v0.17.0](https://github.com/xooxoxxo/tagave/compare/v0.16.0...v0.17.0)

## [v0.16.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.16.0) (2026-11-02)

**Minor release (0.15 → 0.16).** Settings, Library care and Tag changes move under your account, and the physical collection shows one row per record with an Undo for removals.

### Before you update

- **Nothing to do.** No database change in this release.

### New

- **Settings, Library care and Tag changes are under your account.** They open from the compartment above your account at the sidebar's foot, after Account and Listening; the phone menu and the tablet bar follow. A dot on the account shows when something inside is waiting, like open Library care tasks or a new version. ([c1c0a90](https://github.com/xooxoxxo/tagave/commit/c1c0a90))
- **One row per record in the physical collection.** Copies of one release are a single row marked "2 copies"; each row shows its media ("2×CD", "Vinyl") and a drive icon when the album is also on disk. The views are All, Unmapped and Duplicates (only while there are any). "I own both" and "Remove one copy" are in the row's ⋯ menu. ([1b17b61](https://github.com/xooxoxxo/tagave/commit/1b17b61))
- **Undo instead of Removed.** Removing a record takes it off the list with an Undo for 5 seconds; after that it is removed from your Discogs collection too. Leaving the page sooner removes it right away. ([1b17b61](https://github.com/xooxoxxo/tagave/commit/1b17b61))

### Fixed

- The Settings header no longer draws a line across the page as you scroll. ([a816216](https://github.com/xooxoxxo/tagave/commit/a816216))
- The physical collection lost the empty space above its views. ([78e70c7](https://github.com/xooxoxxo/tagave/commit/78e70c7))
- Deleting a module's data checks, inside the same transaction, that the module is still off, so turning it back on mid-delete can't leave half its data. ([a68384d](https://github.com/xooxoxxo/tagave/commit/a68384d))

**All changes:** [v0.15.0...v0.16.0](https://github.com/xooxoxxo/tagave/compare/v0.15.0...v0.16.0)

## [v0.15.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.15.0) (2026-10-27)

**Minor release (0.14 → 0.15).** Moving or renaming music no longer loses anything, colour themes, a player bar that stays on the desktop, and the groundwork for apps beyond music.

### Before you update

- **Split installs** (a files worker on another machine): update that worker right after the app. Until it is updated its scan writes fail for up to 30 seconds, and filter counts and the artist list rebuild only once it runs the new version.
- **Going back to 0.14 means a restore.** This update changes the database (migrations 0052, 0053, 0057, 0058, 0059, 0065, 0066, 0067). The updater takes a backup first and restores it on its own if the update fails; see [Going back](https://github.com/xooxoxxo/tagave/blob/v0.15.0/docs/operations.md).

### New

- **Move-safe scanning.** Moving or renaming music keeps albums, matches, locks, covers, collection links, listens and player links. A scan that would suddenly lose more than 500 files or 20% of a music folder is held, and files are marked missing only if they are still gone 24 hours later. ([7213ee9](https://github.com/xooxoxxo/tagave/commit/7213ee9), [befe103](https://github.com/xooxoxxo/tagave/commit/befe103), [44603db](https://github.com/xooxoxxo/tagave/commit/44603db))
- **Themes** (Settings › Appearance › Theme). Adaptive, Classic, Moody, Mono and Custom, with a colour, hue and second accent of your own. Your theme follows you to every device. The old "Adaptive colours" switch is now the Adaptive theme; browsers that had it off start on Classic. ([620eac9](https://github.com/xooxoxxo/tagave/commit/620eac9), [8ffa270](https://github.com/xooxoxxo/tagave/commit/8ffa270))
- **The player bar stays on the desktop**, lined up with your account; before anything plays its keys are off. ([74180a3](https://github.com/xooxoxxo/tagave/commit/74180a3))
- **Equalizer glow** (off by default, Settings › Appearance) is now an aurora along the foot of the window: three colours from the cover drift slowly and breathe with the music. ([f7957f0](https://github.com/xooxoxxo/tagave/commit/f7957f0))
- **On your phone.** tagave installs to the home screen (over HTTPS) and keeps playing with the phone locked or in the background; the next track starts on its own, and the lock screen and car keys skip tracks. For CarPlay and Android Auto, see [On your phone](https://github.com/xooxoxxo/tagave/blob/v0.15.0/docs/install.md). ([0baabbf](https://github.com/xooxoxxo/tagave/commit/0baabbf), [91e4e5f](https://github.com/xooxoxxo/tagave/commit/91e4e5f))
- **Files without album tags appear.** Each folder's untagged files form an album named after the folder, listed in Library care as "No album tags"; existing libraries are filled in at the next start. ([c93a4a5](https://github.com/xooxoxxo/tagave/commit/c93a4a5), [d6cc39a](https://github.com/xooxoxxo/tagave/commit/d6cc39a))

### Improved

- **New albums are identified right after a scan**, instead of waiting for the next sweep. ([63cf32a](https://github.com/xooxoxxo/tagave/commit/63cf32a))
- **Updates take the whole page**, the glyph edge to edge. ([075d443](https://github.com/xooxoxxo/tagave/commit/075d443))
- **Filter counts** fall back to live numbers if their rebuilds ever stop. ([032b544](https://github.com/xooxoxxo/tagave/commit/032b544))

### Fixed

- Re-scans no longer drop track links after tag writes. ([9d7a1f8](https://github.com/xooxoxxo/tagave/commit/9d7a1f8))
- Music Connections feeds no longer skip a change for a moment while Postgres tidies up. ([0825794](https://github.com/xooxoxxo/tagave/commit/0825794))
- A file whose tags contain stray NUL bytes no longer stops the rest of its folder from being read. ([b6eb76b](https://github.com/xooxoxxo/tagave/commit/b6eb76b))
- If moving a folder's cover image fails, a box cover above CD1/CD2 may be replaced by a fetched cover.

### For self-hosters

- **Migrations:** 0052–0053 and 0057 move-safe files; 0058 `audio_files` becomes `files` (a read-only `audio_files` view stays for this release only); 0059 per-person preferences; 0065 module ledger `installed_modules`; 0066 migrations recorded per module; 0067 filter-count tables renamed `album_filter_counts` and `filter_rail_state`.
- **Modules:** Music Connections, Listen elsewhere and Playlists keep their on/off state, now in `installed_modules`.

**All changes:** [v0.14.1...v0.15.0](https://github.com/xooxoxxo/tagave/compare/v0.14.1...v0.15.0)

## [v0.14.1](https://github.com/xooxoxxo/tagave/releases/tag/v0.14.1) (2026-10-27)

**Minor release (0.13 → 0.14.1); the 0.14.0 build stopped on a slow test and was never published.** A real queue and playlists, Now Playing, colours that follow the cover, "Listen elsewhere" links, cleaner buttons, and the fixes from a full sweep of the app.

### Before you update

- **Nothing to do.**
- **Going back to 0.13 means a restore.** This update changes the database (migrations 0054–0056). The updater takes a backup first and restores it on its own if the update fails; see [Going back](https://github.com/xooxoxxo/tagave/blob/v0.14.1/docs/operations.md).

### New

- **Queue.** Play next and Add to queue from any album or track, drag to reorder, Clear. The queue is kept on the server and follows you between devices; editing it on one device doesn't move playback, pressing Play does. ([c1518dc](https://github.com/xooxoxxo/tagave/commit/c1518dc), [6b2a1f6](https://github.com/xooxoxxo/tagave/commit/6b2a1f6), [9922a3c](https://github.com/xooxoxxo/tagave/commit/9922a3c))
- **Now Playing.** On desktop a full view with the cover, credits, Up next and History; on phones a mini bar that opens a full screen with Playing and Queue. Artist and album names link to their pages. ([6b2a1f6](https://github.com/xooxoxxo/tagave/commit/6b2a1f6), [7964b84](https://github.com/xooxoxxo/tagave/commit/7964b84))
- **Playlists** (module, on by default). Add tracks or albums from ⋮, a Playlists page with cover mosaics, rename, reorder, delete. Export and import `.tagave-playlist.json` (no file paths), and import `.m3u8` and `.xspf`; tracks that don't match stay as Missing. Turning the module off with "Delete its data" removes only its own tables and offers an export first. ([c1518dc](https://github.com/xooxoxxo/tagave/commit/c1518dc), [6b2a1f6](https://github.com/xooxoxxo/tagave/commit/6b2a1f6))
- **Adaptive colours** (on by default, Settings › Appearance). The accent and a faint page tint follow the playing cover; the player bar takes one quiet colour from it. Contrast is checked for every cover. **Equalizer glow** (off by default) lights the track bar with the music; on iPhone and iPad it breathes gently instead. ([a5095a6](https://github.com/xooxoxxo/tagave/commit/a5095a6), [9badc74](https://github.com/xooxoxxo/tagave/commit/9badc74))
- **Listen elsewhere** (module, off by default). Albums you don't own get a Listen control with links to Qobuz, Spotify, Apple Music, YouTube Music, Tidal, Bandcamp, Amazon or Deezer — exact album links where known, otherwise the artist page or a search. Each person picks their services. ([d54d339](https://github.com/xooxoxxo/tagave/commit/d54d339), [4c021c4](https://github.com/xooxoxxo/tagave/commit/4c021c4))

### Improved

- **Buttons.** Icons are centred, circles are whole, and every button has the same hover and press. ([05ba9f7](https://github.com/xooxoxxo/tagave/commit/05ba9f7))
- **Cover art.** Art inside the files and folder images (cover.jpg, folder.jpg) is picked up after a scan, before online art; accepting a match fetches its cover right away. ([10da8e3](https://github.com/xooxoxxo/tagave/commit/10da8e3), [1fa495a](https://github.com/xooxoxxo/tagave/commit/1fa495a))
- **Short albums.** The artwork under the tracklist also shows for 4- and 5-track albums when there is room. ([52ba850](https://github.com/xooxoxxo/tagave/commit/52ba850))
- **Search** ignores accents both ways: "bjork" finds Björk. ([6b16ffa](https://github.com/xooxoxxo/tagave/commit/6b16ffa))

### Fixed

- On a new install without a Discogs token, identification found nothing for hours; MusicBrainz now runs on the first pass and setup finishes. ([429afc8](https://github.com/xooxoxxo/tagave/commit/429afc8))
- "Identify now" queues the waiting albums and says what it did; "Retry selected" no longer fails. ([ad02f49](https://github.com/xooxoxxo/tagave/commit/ad02f49), [acf601c](https://github.com/xooxoxxo/tagave/commit/acf601c))
- Unknown pages and missing albums, artists or plans show "Not found" with a way back. ([e80d11f](https://github.com/xooxoxxo/tagave/commit/e80d11f))
- Sign-in no longer offers "Create owner account" once the owner exists; Playback never shows part of the player password. ([26efcc4](https://github.com/xooxoxxo/tagave/commit/26efcc4), [83bb880](https://github.com/xooxoxxo/tagave/commit/83bb880))
- Settings › Modules on installs without the updater lists the player as not available instead of an empty command. ([3f63757](https://github.com/xooxoxxo/tagave/commit/3f63757))
- Many smaller fixes to counts, plurals, labels and dates across Library care, Albums, Settings and Updates.

### For self-hosters

- **Migrations:** 0054 listen links, 0055 player queue state, 0056 playlists.
- **Modules:** `tagave-doctor purge-module listen-links` and `purge-module playlists` remove exactly their data, and refuse while the module is on.

**All changes:** [v0.13.1...v0.14.1](https://github.com/xooxoxxo/tagave/compare/v0.13.1...v0.14.1)

## [v0.14.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.14.0) (2026-10-27)

**Minor release (0.13 → 0.14).** A real queue and playlists, Now Playing, colours that follow the cover, "Listen elsewhere" links, cleaner buttons, and the fixes from a full sweep of the app.

### Before you update

- **Nothing to do.**
- **Going back to 0.13 means a restore.** This update changes the database (migrations 0054–0056). The updater takes a backup first and restores it on its own if the update fails; see [Going back](https://github.com/xooxoxxo/tagave/blob/v0.14.0/docs/operations.md).

### New

- **Queue.** Play next and Add to queue from any album or track, drag to reorder, Clear. The queue is kept on the server and follows you between devices; editing it on one device doesn't move playback, pressing Play does. ([c1518dc](https://github.com/xooxoxxo/tagave/commit/c1518dc), [6b2a1f6](https://github.com/xooxoxxo/tagave/commit/6b2a1f6), [9922a3c](https://github.com/xooxoxxo/tagave/commit/9922a3c))
- **Now Playing.** On desktop a full view with the cover, credits, Up next and History; on phones a mini bar that opens a full screen with Playing and Queue. Artist and album names link to their pages. ([6b2a1f6](https://github.com/xooxoxxo/tagave/commit/6b2a1f6), [7964b84](https://github.com/xooxoxxo/tagave/commit/7964b84))
- **Playlists** (module, on by default). Add tracks or albums from ⋮, a Playlists page with cover mosaics, rename, reorder, delete. Export and import `.tagave-playlist.json` (no file paths), and import `.m3u8` and `.xspf`; tracks that don't match stay as Missing. Turning the module off with "Delete its data" removes only its own tables and offers an export first. ([c1518dc](https://github.com/xooxoxxo/tagave/commit/c1518dc), [6b2a1f6](https://github.com/xooxoxxo/tagave/commit/6b2a1f6))
- **Adaptive colours** (on by default, Settings › Appearance). The accent and a faint page tint follow the playing cover; the player bar takes one quiet colour from it. Contrast is checked for every cover. **Equalizer glow** (off by default) lights the track bar with the music; on iPhone and iPad it breathes gently instead. ([a5095a6](https://github.com/xooxoxxo/tagave/commit/a5095a6), [9badc74](https://github.com/xooxoxxo/tagave/commit/9badc74))
- **Listen elsewhere** (module, off by default). Albums you don't own get a Listen control with links to Qobuz, Spotify, Apple Music, YouTube Music, Tidal, Bandcamp, Amazon or Deezer — exact album links where known, otherwise the artist page or a search. Each person picks their services. ([d54d339](https://github.com/xooxoxxo/tagave/commit/d54d339), [4c021c4](https://github.com/xooxoxxo/tagave/commit/4c021c4))

### Improved

- **Buttons.** Icons are centred, circles are whole, and every button has the same hover and press. ([05ba9f7](https://github.com/xooxoxxo/tagave/commit/05ba9f7))
- **Cover art.** Art inside the files and folder images (cover.jpg, folder.jpg) is picked up after a scan, before online art; accepting a match fetches its cover right away. ([10da8e3](https://github.com/xooxoxxo/tagave/commit/10da8e3), [1fa495a](https://github.com/xooxoxxo/tagave/commit/1fa495a))
- **Short albums.** The artwork under the tracklist also shows for 4- and 5-track albums when there is room. ([52ba850](https://github.com/xooxoxxo/tagave/commit/52ba850))
- **Search** ignores accents both ways: "bjork" finds Björk. ([6b16ffa](https://github.com/xooxoxxo/tagave/commit/6b16ffa))

### Fixed

- On a new install without a Discogs token, identification found nothing for hours; MusicBrainz now runs on the first pass and setup finishes. ([429afc8](https://github.com/xooxoxxo/tagave/commit/429afc8))
- "Identify now" queues the waiting albums and says what it did; "Retry selected" no longer fails. ([ad02f49](https://github.com/xooxoxxo/tagave/commit/ad02f49), [acf601c](https://github.com/xooxoxxo/tagave/commit/acf601c))
- Unknown pages and missing albums, artists or plans show "Not found" with a way back. ([e80d11f](https://github.com/xooxoxxo/tagave/commit/e80d11f))
- Sign-in no longer offers "Create owner account" once the owner exists; Playback never shows part of the player password. ([26efcc4](https://github.com/xooxoxxo/tagave/commit/26efcc4), [83bb880](https://github.com/xooxoxxo/tagave/commit/83bb880))
- Settings › Modules on installs without the updater lists the player as not available instead of an empty command. ([3f63757](https://github.com/xooxoxxo/tagave/commit/3f63757))
- Many smaller fixes to counts, plurals, labels and dates across Library care, Albums, Settings and Updates.

### For self-hosters

- **Migrations:** 0054 listen links, 0055 player queue state, 0056 playlists.
- **Modules:** `tagave-doctor purge-module listen-links` and `purge-module playlists` remove exactly their data, and refuse while the module is on.

**All changes:** [v0.13.1...v0.14.0](https://github.com/xooxoxxo/tagave/compare/v0.13.1...v0.14.0)

## [v0.13.1](https://github.com/xooxoxxo/tagave/releases/tag/v0.13.1) (2026-10-20)

**Patch release (0.13.0 → 0.13.1); the same changes as 0.13.0, which was published without its signed files and cannot be installed.** Updates you can watch, a tidier sidebar foot, short albums that fit the window, and docs at tagave.app/docs.

### Before you update

- **Nothing to do.** No database change in this release.
- **This update still shows the old progress view:** the updater that is running draws it. The new update view appears from the next update on.

### New

- **The update takes over Settings › Updates.** A slow lava-lamp glyph, drawn from the target version, grows with progress above the steps; it settles on success and tints on failure. Other people only see a calm "Updating" screen while the app restarts, and their page switches to the new version when nothing is playing. ([71d7380](https://github.com/xooxoxxo/tagave/commit/71d7380), [acd25ff](https://github.com/xooxoxxo/tagave/commit/acd25ff))
- **Steps roll in as they start,** each with one live line: what is downloading and how much, the backup's size, the migration being applied, how many parts run the new version. ([0e4d4e8](https://github.com/xooxoxxo/tagave/commit/0e4d4e8), [1e2592f](https://github.com/xooxoxxo/tagave/commit/1e2592f))
- **Account at the sidebar's foot.** One row, level with the player bar; it opens a compartment above it with Account, Listening, the theme and Sign out. ([3de534b](https://github.com/xooxoxxo/tagave/commit/3de534b), [93c8da6](https://github.com/xooxoxxo/tagave/commit/93c8da6))
- **Docs at tagave.app/docs.** Every guide and the changelog; help links in the app open there. ([0e2b4ca](https://github.com/xooxoxxo/tagave/commit/0e2b4ca), [79a302e](https://github.com/xooxoxxo/tagave/commit/79a302e))

### Improved

- **Short albums fit the window.** The artwork under a one-to-three-track album fills only the space left, so the page no longer scrolls. ([28198c4](https://github.com/xooxoxxo/tagave/commit/28198c4))
- **Album pages end with the music.** The Discogs credit moved to Album info › About. ([3de534b](https://github.com/xooxoxxo/tagave/commit/3de534b))

### Fixed

- Releases are published only once their signed files are attached (0.13.0 went out without them).
- The disk check counted every pinned image as 1 GB and the download line could only count layers; image sizes are read correctly now. ([cfd3448](https://github.com/xooxoxxo/tagave/commit/cfd3448))
- The update log no longer repeats the step line, and the backup-size check runs one at a time and ignores leftovers of a crashed backup. ([5396432](https://github.com/xooxoxxo/tagave/commit/5396432), [3da7911](https://github.com/xooxoxxo/tagave/commit/3da7911))
- On phones, the menu sheet no longer runs under the player bar. ([93c8da6](https://github.com/xooxoxxo/tagave/commit/93c8da6))

**All changes:** [v0.12.0...v0.13.1](https://github.com/xooxoxxo/tagave/compare/v0.12.0...v0.13.1)

## [v0.13.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.13.0) (2026-10-20)

**Minor release (0.12 → 0.13).** Updates you can watch, a tidier sidebar foot, short albums that fit the window, and docs at tagave.app/docs.

### Before you update

- **Nothing to do.** No database change in this release.
- **This update still shows the old progress view:** the updater that is running draws it. The new update view appears from the next update on.

### New

- **The update takes over Settings › Updates.** A slow lava-lamp glyph, drawn from the target version, grows with progress above the steps; it settles on success and tints on failure. Other people only see a calm "Updating" screen while the app restarts, and their page switches to the new version when nothing is playing. ([71d7380](https://github.com/xooxoxxo/tagave/commit/71d7380), [acd25ff](https://github.com/xooxoxxo/tagave/commit/acd25ff))
- **Steps roll in as they start,** each with one live line: what is downloading and how much, the backup's size, the migration being applied, how many parts run the new version. ([0e4d4e8](https://github.com/xooxoxxo/tagave/commit/0e4d4e8), [1e2592f](https://github.com/xooxoxxo/tagave/commit/1e2592f))
- **Account at the sidebar's foot.** One row, level with the player bar; it opens a compartment above it with Account, Listening, the theme and Sign out. ([3de534b](https://github.com/xooxoxxo/tagave/commit/3de534b), [93c8da6](https://github.com/xooxoxxo/tagave/commit/93c8da6))
- **Docs at tagave.app/docs.** Every guide and the changelog; help links in the app open there. ([0e2b4ca](https://github.com/xooxoxxo/tagave/commit/0e2b4ca), [79a302e](https://github.com/xooxoxxo/tagave/commit/79a302e))

### Improved

- **Short albums fit the window.** The artwork under a one-to-three-track album fills only the space left, so the page no longer scrolls. ([28198c4](https://github.com/xooxoxxo/tagave/commit/28198c4))
- **Album pages end with the music.** The Discogs credit moved to Album info › About. ([3de534b](https://github.com/xooxoxxo/tagave/commit/3de534b))

### Fixed

- The disk check counted every pinned image as 1 GB and the download line could only count layers; image sizes are read correctly now. ([cfd3448](https://github.com/xooxoxxo/tagave/commit/cfd3448))
- The update log no longer repeats the step line, and the backup-size check runs one at a time and ignores leftovers of a crashed backup. ([5396432](https://github.com/xooxoxxo/tagave/commit/5396432), [3da7911](https://github.com/xooxoxxo/tagave/commit/3da7911))
- On phones, the menu sheet no longer runs under the player bar. ([93c8da6](https://github.com/xooxoxxo/tagave/commit/93c8da6))

**All changes:** [v0.12.0...v0.13.0](https://github.com/xooxoxxo/tagave/compare/v0.12.0...v0.13.0)

## [v0.12.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.12.0) (2026-10-20)

**Minor release (0.11 → 0.12).** A cleaner Backups page with the version of every backup, reverse proxies that work without setup, a per-account sign-in limit, and critic scores as one list.

### Before you update

- **Nothing to do.** No database change in this release.
- **If you set `TRUST_PROXY` for 0.11:** you can remove it; proxies on private networks (Docker, your LAN) are now trusted without it. Keep it only for a proxy on a public address. ([01c99e3](https://github.com/xooxoxxo/tagave/commit/01c99e3))

### New

- **Backups page.** Each kind (Nightly, Before update, Manual) is one group of settings rows that save on their own, with its backups listed underneath: date · version · size · ⋯. The ⋯ menu has Download, Copy restore command and Delete; backups the next run removes are marked *Expires*. ([fc3f25a](https://github.com/xooxoxxo/tagave/commit/fc3f25a))
- **Backup versions.** New backups record the tagave version they were taken from; older ones show a version worked out from the update history (~0.10.0), and before-update backups show from → to. ([88b6531](https://github.com/xooxoxxo/tagave/commit/88b6531))
- **Critic scores as one list.** On the album's Reviews tab, critic scores and From the web read as one ledger, with outlet and source on each score; Clear, History and Delete sit together. ([a97bd32](https://github.com/xooxoxxo/tagave/commit/a97bd32), [4d31ee0](https://github.com/xooxoxxo/tagave/commit/4d31ee0))

### Improved

- **Reverse proxies need no setup.** Caddy, nginx, Traefik or a tunnel on the same Docker network or your LAN are trusted to name the visitor, so each visitor gets their own rate limits. Settings › System warns in one line only when a proxy on a public address sends headers tagave can't use. ([01c99e3](https://github.com/xooxoxxo/tagave/commit/01c99e3), [d6fd527](https://github.com/xooxoxxo/tagave/commit/d6fd527))
- **Sign-in limit per account.** 10 wrong passwords in 15 minutes per account, whatever address the attempts come from. ([01c99e3](https://github.com/xooxoxxo/tagave/commit/01c99e3))

### For self-hosters

- **`TRUST_PROXY`** is now an advanced option: unset trusts private addresses; `off` trusts none; a hop count or addresses/CIDRs as before. The docs recommend reaching tagave over a shared Docker network or binding its port to a private address (docs/security.md › Reverse proxy and client addresses).

**All changes:** [v0.11.0...v0.12.0](https://github.com/xooxoxxo/tagave/compare/v0.11.0...v0.12.0)

## [v0.11.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.11.0) (2026-10-20)

**Minor release (0.10 → 0.11).** Updates that finish clear themselves, a first-run setup checklist, a fixed Settings menu, page titles on phones, and security fixes.

### Before you update

**Requires attention:** behind a reverse proxy, set `TRUST_PROXY` after updating.

- **Behind a reverse proxy (Caddy, nginx, Traefik), set `TRUST_PROXY=1`** in `.env` (or the hop count, or the proxy's network). Without it, sign-in and API rate limits are one shared limit for everyone. `TRUST_PROXY=true` now means one hop; an invalid value stops the app at start. See docs/security.md › Reverse proxy and client addresses. ([0b7e648](https://github.com/xooxoxxo/tagave/commit/0b7e648))
- **Correction to the 0.10 notes:** rotating `APP_SECRET` no longer sends Music Connections links to re-approval; `tagave-doctor reseal` now re-encrypts their tokens. ([418b840](https://github.com/xooxoxxo/tagave/commit/418b840))
- **Going back to 0.10 means a restore.** This update changes the database (migration 0051). The updater takes a backup first and restores it on its own if the update fails; see [Going back](https://github.com/xooxoxxo/tagave/blob/v0.11.0/docs/operations.md).

### New

- **A finished update clears itself.** Once the new version runs, the update card disappears in every browser; failed or rolled-back updates still wait for you. ([767aef7](https://github.com/xooxoxxo/tagave/commit/767aef7))
- **Setup checklist on first run.** It shows on Home until the required steps are done, then leaves; it's no longer in the Settings menu. ([50e704b](https://github.com/xooxoxxo/tagave/commit/50e704b))
- **Settings menu stays put.** On desktop the section list and the Settings header stay fixed while the page scrolls. On phones, Settings is a list of sections, each with Back. ([ced60a4](https://github.com/xooxoxxo/tagave/commit/ced60a4))
- **Page titles on phones.** The top bar names the page (Albums, Artists, Settings…) instead of showing the app name. ([ced60a4](https://github.com/xooxoxxo/tagave/commit/ced60a4))

### Fixed

- The album Reviews tab fits the side sheet and phones again. ([1dc03db](https://github.com/xooxoxxo/tagave/commit/1dc03db))
- Library settings saved in the wrong format by some tools are repaired, so key re-encryption and player removal read them correctly. ([c8fa292](https://github.com/xooxoxxo/tagave/commit/c8fa292), [fd024a4](https://github.com/xooxoxxo/tagave/commit/fd024a4), [d75cd6d](https://github.com/xooxoxxo/tagave/commit/d75cd6d))
- Music Connections: wantlist decisions limited to 30 a minute per person, invalid tokens can't load the database, refreshed links get exactly the scope asked for, and ended links are cleaned up. ([7c352bd](https://github.com/xooxoxxo/tagave/commit/7c352bd), [0b7e648](https://github.com/xooxoxxo/tagave/commit/0b7e648), [4859a32](https://github.com/xooxoxxo/tagave/commit/4859a32), [454dc56](https://github.com/xooxoxxo/tagave/commit/454dc56))
- Pasting a release on Identify no longer rewrites a linked app's suggestion. ([8ebcbc6](https://github.com/xooxoxxo/tagave/commit/8ebcbc6))

### For self-hosters

- **Migration:** 0051 library settings object.
- **`TRUST_PROXY`:** hop count or CIDRs; `true` = 1 hop.

**All changes:** [v0.10.0...v0.11.0](https://github.com/xooxoxxo/tagave/compare/v0.10.0...v0.11.0)

## [v0.10.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.10.0) (2026-10-20)

**Minor release (0.9 → 0.10).** A new album page with Shuffle and a ⋮ drawer, far less text on every page, scrobbling that catches up when you connect, cleaner player removal, and Music Connections (off until you turn it on).

### Before you update

**Requires attention:** check free disk space before you start, and delete old before-update backups once afterwards.

- **Free disk for the cover change.** Migration 0046 moves cover thumbnails into their own table and needs about 3× their size free on the database disk while it runs (about 0.9 GB on a 27,000-album library). The update refuses to start if there isn't enough; `TAGAVE_SKIP_MIGRATION_SPACE_CHECK=1` skips the check. ([b2bd335](https://github.com/xooxoxxo/tagave/commit/b2bd335), [a1db9e7](https://github.com/xooxoxxo/tagave/commit/a1db9e7))
- **A short pause during the update.** Migration 0048 adds a change log to seven tables; expect seconds to about a minute on a large library. ([74f05cf](https://github.com/xooxoxxo/tagave/commit/74f05cf))
- **Old before-update backups.** Backups the 0.9 updater made show under *Manual* on Settings › Backups and are never deleted automatically. Delete them once by hand.
- **Your own backup scripts:** if you run `pg_dump` yourself, add `--exclude-table-data=public.cover_thumbs` (and `public.provider_cache` for routine dumps).
- **Music Connections is off by default.** Turn it on in Settings › Modules. If you later rotate `APP_SECRET`, every link goes back to *Needs re-approval*. ([b441a56](https://github.com/xooxoxxo/tagave/commit/b441a56))
- **Going back to 0.9 means a restore.** This update changes the database (migrations 0046–0050). The updater takes a backup first and restores it on its own if the update fails; to return later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.10.0/docs/operations.md).

### New

- **Album page.** Centred cover, genre and year, title, artist, one facts line and a short excerpt with *More*. Shuffle and Play below; the tracks follow straight after. ⋮ in the header opens a drawer on phones (a menu on desktop) with the album's actions, *Album info* (About, Reviews) and the Maintenance switch, which replaces the wrench. ([15e979c](https://github.com/xooxoxxo/tagave/commit/15e979c), [7a79782](https://github.com/xooxoxxo/tagave/commit/7a79782), [5a05e41](https://github.com/xooxoxxo/tagave/commit/5a05e41))
- **Shuffle.** Plays the album in a random order; shuffled plays count as listens like any other. ([eab8d5f](https://github.com/xooxoxxo/tagave/commit/eab8d5f))
- **Scrobbling catches up.** Connecting Last.fm or ListenBrainz sends your plays from the last 14 days. Settings › Listening shows when each service last received a play. ([91e68a8](https://github.com/xooxoxxo/tagave/commit/91e68a8), [3e49928](https://github.com/xooxoxxo/tagave/commit/3e49928))
- **Music Connections** (module, off by default). Link tagave to another app you run, such as a critic-review aggregator: see critic scores on albums, accept or dismiss wantlist suggestions, and fill missing MusicBrainz identities. Links are approved in the browser, scoped and revocable; nothing in your library is overwritten. ([052e0b9](https://github.com/xooxoxxo/tagave/commit/052e0b9), [5cdf932](https://github.com/xooxoxxo/tagave/commit/5cdf932), [62204a2](https://github.com/xooxoxxo/tagave/commit/62204a2))
- **Update progress.** Settings › Updates shows what each step is doing and says why a step stalled. ([746236e](https://github.com/xooxoxxo/tagave/commit/746236e), [734c9e5](https://github.com/xooxoxxo/tagave/commit/734c9e5))

### Improved

- **Less text everywhere.** About half the words are gone: pages show labels and values, explanations moved to the docs, dates are short ("19 Oct, 22:21"), passing health checks fold into one "OK" line, and the Discogs notice shows only where Discogs is used. ([ff53bfa](https://github.com/xooxoxxo/tagave/commit/ff53bfa), [51285a1](https://github.com/xooxoxxo/tagave/commit/51285a1))
- **Scrobbling settings.** A saved Last.fm key shows as one line with Replace and Remove; your own connection is right below it. ([4105de2](https://github.com/xooxoxxo/tagave/commit/4105de2))
- **Removing the player.** *Delete its data* now also removes the player's rows in tagave and the connected Last.fm and ListenBrainz accounts. Your listens stay unless you tick *Also delete the listens the player recorded*. A server of your own in Settings › Playback keeps its data. ([1e71295](https://github.com/xooxoxxo/tagave/commit/1e71295), [254bf10](https://github.com/xooxoxxo/tagave/commit/254bf10))
- **Smaller backups, one per update.** Cover thumbnails and the provider cache are left out of backups and rebuilt after a restore; an update takes one database backup instead of two. ([53b5253](https://github.com/xooxoxxo/tagave/commit/53b5253), [ed69ead](https://github.com/xooxoxxo/tagave/commit/ed69ead))
- **Faster covers.** Thumbnails are served with an ETag and rebuilt in the background when missing. ([57956dd](https://github.com/xooxoxxo/tagave/commit/57956dd), [6b577bc](https://github.com/xooxoxxo/tagave/commit/6b577bc))

### Fixed

- With the player off, plays waiting to be reported were marked as never to report. ([bb86cd4](https://github.com/xooxoxxo/tagave/commit/bb86cd4))
- Enough requests from different addresses could reset the limits on Settings › Users and invite links. ([e84053c](https://github.com/xooxoxxo/tagave/commit/e84053c))
- The app can no longer be shown inside another site's frame. ([a0a392d](https://github.com/xooxoxxo/tagave/commit/a0a392d))
- An interrupted update now points at the backup the app took. ([5e19dad](https://github.com/xooxoxxo/tagave/commit/5e19dad))

### For self-hosters

- **Migrations:** 0046 cover thumbs, 0047–0050 Music Connections (OAuth, change log, links, landing).
- **New settings:** `MC_TRUSTED_PUBLIC_HOSTS` (`.env.example`), `TAGAVE_UPDATER_STALL_SECONDS` (default 120, `compose.yml`).
- **Before-update backups:** existing installs keep 5, new installs 3; the minimum is now 1. ([3718702](https://github.com/xooxoxxo/tagave/commit/3718702))
- **Installer:** `disable-module player` asks whether to delete play history (`--delete-history`). ([88250fa](https://github.com/xooxoxxo/tagave/commit/88250fa))
- **Releases:** notes like these are now written per release in `release-notes/`, and CI refuses a release without them. ([a9dbd9e](https://github.com/xooxoxxo/tagave/commit/a9dbd9e))

**All changes:** [v0.9.0...v0.10.0](https://github.com/xooxoxxo/tagave/compare/v0.9.0...v0.10.0)

## [v0.9.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.9.0) (2026-10-16)

**Minor release (0.8 → 0.9).** tagave now has several people with their own roles, playback and scrobbling; optional parts install from Settings › Modules; every release is signed. Liner is now called tagave everywhere.

### Before you update

- **Going back to 0.8 means a restore.** This update changes the database (migrations 0042–0045). The updater takes a backup first and restores it on its own if the update fails; to return to 0.8 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.9.0/docs/operations.md).
- **Split install (file worker on another computer):** stop `worker-files` there first, update the app computer, then the music computer.
- **Accounts called "viewer" become "listener".** Nothing to do; they keep read access and gain playback if the player is on.
- **Old `LINER_*` settings still work** and log a one-time warning. The updater renames them in `.env` for you. They stop working in 0.10.

### New

- **People and roles.** Invite people from Settings › Users with a one-time link. Roles: *owner* (everything), *editor* (edit the library), *listener* (browse and play). Every API route now checks the role; anything unlisted is refused. ([a19494a](https://github.com/xooxoxxo/tagave/commit/a19494a), [ad58058](https://github.com/xooxoxxo/tagave/commit/ad58058))
- **Your own playback.** Each person gets their own player account, queue and listen history. Phone apps (Subsonic clients) sign in with a per-person app password from Settings › Listening. ([3a17aba](https://github.com/xooxoxxo/tagave/commit/3a17aba), [8b8b785](https://github.com/xooxoxxo/tagave/commit/8b8b785))
- **Scrobbling to Last.fm and ListenBrainz.** The owner adds one Last.fm API key in Settings › Playback › Scrobbling; each person then connects their own account in Settings › Listening. Plays from phone apps count too. ([ca35e04](https://github.com/xooxoxxo/tagave/commit/ca35e04), [74bb32e](https://github.com/xooxoxxo/tagave/commit/74bb32e))
- **Settings › Modules.** Turn the player on or off with one click, no terminal. Needs the in-app updater; without it the page shows the one command to run. ([d084f8a](https://github.com/xooxoxxo/tagave/commit/d084f8a), [cf437c3](https://github.com/xooxoxxo/tagave/commit/cf437c3))
- **Signed releases.** Each release ships a manifest signed with the project's release key, listing every image by digest. The updater and the installer refuse a release that is unsigned, altered or older than the one you run. ([cf437c3](https://github.com/xooxoxxo/tagave/commit/cf437c3), [935060e](https://github.com/xooxoxxo/tagave/commit/935060e))
- **Disk space warnings.** Settings › Storage shows free space; the owner sees a notice at 85 % full, and the doctor fails at 95 %. An update the disk can't take is refused before it starts. ([2cd8584](https://github.com/xooxoxxo/tagave/commit/2cd8584), [c6dc762](https://github.com/xooxoxxo/tagave/commit/c6dc762), [6d1b9c5](https://github.com/xooxoxxo/tagave/commit/6d1b9c5))
- **Backups by kind.** Settings › Backups shows nightly, manual, before-update and before-restore backups separately, each with its own retention. ([8550cae](https://github.com/xooxoxxo/tagave/commit/8550cae), [25f37d5](https://github.com/xooxoxxo/tagave/commit/25f37d5))

### Improved

- **Album page.** Tracks / Editions / About / Activity appear in Maintenance only; the details are two short lines; Play sits in the title row and says how far the player's first scan is. ([b37134d](https://github.com/xooxoxxo/tagave/commit/b37134d))
- **Updates clean up after themselves.** Old images are removed after a successful update. ([7dc16fe](https://github.com/xooxoxxo/tagave/commit/7dc16fe))

### Fixed

- Settings › Storage said "Only the owner can see this page" for every error; it now says what failed, e.g. the database being down. ([e88dcba](https://github.com/xooxoxxo/tagave/commit/e88dcba))
- The updater wrote `.env` and `compose.yml` as root; it now keeps each file's owner and mode. ([f9de5ca](https://github.com/xooxoxxo/tagave/commit/f9de5ca))
- An update could hang while the updater replaced itself; it now waits and says so. ([51c51e1](https://github.com/xooxoxxo/tagave/commit/51c51e1), [a0794bf](https://github.com/xooxoxxo/tagave/commit/a0794bf))
- The doctor could hang creating the backup or cache folder. ([e5b25ed](https://github.com/xooxoxxo/tagave/commit/e5b25ed))
- Removing a person ends their player access and their invite links. ([c6a2cb4](https://github.com/xooxoxxo/tagave/commit/c6a2cb4))
- One-time links and Last.fm tokens no longer appear in the request log. ([4acfa0a](https://github.com/xooxoxxo/tagave/commit/4acfa0a))

### For self-hosters

- **Rename.** Packages are `@tagave/*`; settings are `TAGAVE_*` (`LINER_VERSION` is now `TAGAVE_BUILD_VERSION`); the CLI is `tagave-doctor` (`liner-doctor` still works); new backups are `tagave-<time>.pgdump`, old `liner-*` dumps are still listed and restorable. ([85f852f](https://github.com/xooxoxxo/tagave/commit/85f852f), [3544dca](https://github.com/xooxoxxo/tagave/commit/3544dca))
- **Migrations:** 0042 tagave names, 0043 users and roles, 0044 per-person player, 0045 retired player accounts.
- **Images are pinned by digest** in `compose.yml` (`TAGAVE_DIGEST_*`). The release key's public half is in `deploy/release-keys/` (key id `71fba65e021ad172`).
- **Installer:** `./install-tagave.sh enable-module player` / `disable-module player`; keeps the newest 3 pre-update dumps.

**All changes:** [v0.8.0...v0.9.0](https://github.com/xooxoxxo/tagave/compare/v0.8.0...v0.9.0)

## [v0.8.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.8.0) (2026-10-15)

**Minor release (0.7 → 0.8).** tagave can now play your albums, through an optional player you turn on with one command or a Subsonic server you already run.

### Before you update

- **Going back to 0.7 means a restore.** This update changes the database (migration 0041). The updater takes a backup first and restores it on its own if the update fails; to return to 0.7 later, follow [Roll back](https://github.com/xooxoxxo/tagave/blob/v0.8.0/docs/operations.md#roll-back).
- **The player stays off.** Nothing changes for you unless you turn it on; the new `TAGAVE_PLAYER_*` settings are written only by `enable-player`.

### New

- **Play albums in tagave.** Play and Play from here on the album page, a player bar at the bottom of every page that keeps playing while you browse, the next track loaded ahead, Space to pause, and your keyboard's or phone's media keys. The bar only appears once a player is set up and answers. ([a636864](https://github.com/xooxoxxo/tagave/commit/a636864), [33e465a](https://github.com/xooxoxxo/tagave/commit/33e465a))
- **Settings › Playback.** Choose the bundled player or your own Navidrome (or any Subsonic-compatible server), and pick a streaming quality per device. ([a636864](https://github.com/xooxoxxo/tagave/commit/a636864))
- **The player keeps up with your edits.** After tagave writes tags, it asks the player to rescan just that folder. ([33e465a](https://github.com/xooxoxxo/tagave/commit/33e465a))

### Improved

- tagave calls itself tagave in messages, the API docs and the user agent it sends to MusicBrainz, Discogs and the Cover Art Archive. Setting names, `liner-doctor` and the database name are unchanged. ([f2feac5](https://github.com/xooxoxxo/tagave/commit/f2feac5))

### For self-hosters

- **Turning the player on.** `./install-tagave.sh enable-player` (or `--with-player` when installing) adds the `player` profile, generates Navidrome's admin password and encryption key into `.env` only, and starts it; `disable-player` turns it off and asks before deleting its data. Single-computer installs only for now; on a split install, run your own Navidrome and use Settings › Playback. See [Play your music](https://github.com/xooxoxxo/tagave/blob/v0.8.0/docs/install.md#play-your-music-optional-player). ([772d958](https://github.com/xooxoxxo/tagave/commit/772d958), [f746b64](https://github.com/xooxoxxo/tagave/commit/f746b64))
- **The player is unmodified Navidrome 0.64.0.** It reads the music folder read-only (even with `--music-writable`), keeps its data in the `player-data` volume, and is capped at 512 MB and one core. Its port, 4533 by default (`--player-port`), is meant for phone apps at home: never forward it from your router. ([772d958](https://github.com/xooxoxxo/tagave/commit/772d958))
- **Updates and the player.** When a release pins a new Navidrome, the update copies the player's data first and a roll back puts it back. A player that does not come back after an update only warns. ([772d958](https://github.com/xooxoxxo/tagave/commit/772d958))
- **Migration:** 0041 player (track map, play events, scan requests).
- **New settings** in `compose.yml`: `TAGAVE_PLAYER_URL`, `TAGAVE_PLAYER_USER`, `TAGAVE_PLAYER_PASSWORD`, `TAGAVE_PLAYER_ENCRYPTION_KEY`, `TAGAVE_PLAYER_PORT`, `TAGAVE_PLAYER_IMAGE` (an override; not supported).

**All changes:** [v0.7.7...v0.8.0](https://github.com/xooxoxxo/tagave/compare/v0.7.7...v0.8.0)

## [v0.7.7](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.7) (2026-10-15)

_Generated from the commits; not edited by hand._

**Patch release (0.7.6 → 0.7.7).**

### Before you update

- Nothing to do before this update.

### New

- **web:** Notice a newer server build and reload safely after an update ([949e18e](https://github.com/xooxoxxo/tagave/commit/949e18e))

### Fixed

- **api:** Answer a missing build asset with 404, not the app shell ([6752d58](https://github.com/xooxoxxo/tagave/commit/6752d58))
- **web:** Plain empty states on Home ([8720d30](https://github.com/xooxoxxo/tagave/commit/8720d30))

**All changes:** [v0.7.6...v0.7.7](https://github.com/xooxoxxo/tagave/compare/v0.7.6...v0.7.7)

## [v0.7.6](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.6) (2026-10-13)

_Generated from the commits; not edited by hand._

**Patch release (0.7.5 → 0.7.6).**

### Before you update

- **Going back to 0.7.5 means a restore.** This update changes the database (migration 0040). The updater takes a backup first and restores it on its own if the update fails; to return to 0.7.5 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.7.6/docs/operations.md).

### New

- **api:** Albums matched by tags belong to their artist ([83d642f](https://github.com/xooxoxxo/tagave/commit/83d642f))
- **web:** The new artist page, name first or like albums ([69c9ed2](https://github.com/xooxoxxo/tagave/commit/69c9ed2))
- **web:** A Storybook component library with story tests ([eae9837](https://github.com/xooxoxxo/tagave/commit/eae9837))

### Fixed

- **core:** Artist dates come from MusicBrainz life-span ([6baf7d4](https://github.com/xooxoxxo/tagave/commit/6baf7d4))
- **web:** The segmented control and tab pill sit dead centre ([c6d6860](https://github.com/xooxoxxo/tagave/commit/c6d6860))
- **worker:** Enrich an artist under a library that holds its albums ([e7990cd](https://github.com/xooxoxxo/tagave/commit/e7990cd))

### For self-hosters

- **Migrations:** 0040 artist tag albums.

**All changes:** [v0.7.5...v0.7.6](https://github.com/xooxoxxo/tagave/compare/v0.7.5...v0.7.6)

## [v0.7.5](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.5) (2026-10-11)

_Generated from the commits; not edited by hand._

**Patch release (0.7.4 → 0.7.5).**

### Before you update

- Nothing to do before this update.

### New

- **web:** Opt-in freeze diagnostics in the browser console ([2a13c2b](https://github.com/xooxoxxo/tagave/commit/2a13c2b))

### Fixed

- **web:** Short-album artwork no longer freezes the album page ([d354b9f](https://github.com/xooxoxxo/tagave/commit/d354b9f))
- **web:** The live job stream comes back after a 502 ([a0d6b4f](https://github.com/xooxoxxo/tagave/commit/a0d6b4f))

**All changes:** [v0.7.4...v0.7.5](https://github.com/xooxoxxo/tagave/compare/v0.7.4...v0.7.5)

## [v0.7.4](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.4) (2026-10-11)

_Generated from the commits; not edited by hand._

**Patch release (0.7.3 → 0.7.4).**

### Before you update

- Nothing to do before this update.

### Fixed

- **web:** Passkey re-verification can be stopped and never waits on the sign-in request ([0fb6beb](https://github.com/xooxoxxo/tagave/commit/0fb6beb))
- **web:** Settings › Updates matches the other Settings pages ([def8af6](https://github.com/xooxoxxo/tagave/commit/def8af6))

**All changes:** [v0.7.3...v0.7.4](https://github.com/xooxoxxo/tagave/compare/v0.7.3...v0.7.4)

## [v0.7.3](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.3) (2026-10-11)

_Generated from the commits; not edited by hand._

**Patch release (0.7.2 → 0.7.3).**

### Before you update

- Nothing to do before this update.

### Fixed

- **web:** Sizes under 1 KB show whole bytes; 0.7.3 ([5d61e34](https://github.com/xooxoxxo/tagave/commit/5d61e34))

**All changes:** [v0.7.2...v0.7.3](https://github.com/xooxoxxo/tagave/compare/v0.7.2...v0.7.3)

## [v0.7.2](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.2) (2026-10-11)

_Generated from the commits; not edited by hand._

**Patch release (0.7.1 → 0.7.2).**

### Before you update

- **Settings in `deploy/compose.yml`:** added `TAGAVE_MUSIC_MODE`.

### For self-hosters

- **installer:** --music-writable mounts the music read-write for tag writes ([60518b3](https://github.com/xooxoxxo/tagave/commit/60518b3))

**All changes:** [v0.7.1...v0.7.2](https://github.com/xooxoxxo/tagave/compare/v0.7.1...v0.7.2)

## [v0.7.1](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.1) (2026-10-11)

_Generated from the commits; not edited by hand._

**Patch release (0.7.0 → 0.7.1).**

### Before you update

- **Going back to 0.7.0 means a restore.** This update changes the database (migration 0039). The updater takes a backup first and restores it on its own if the update fails; to return to 0.7.0 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.7.1/docs/operations.md).
- **Settings in `deploy/compose.yml`:** added `TAGAVE_INSTALL_DIR`, `TAGAVE_UPDATER_HEALTH_TIMEOUT`, `TAGAVE_UPDATER_MIN_FREE_MB`, `TAGAVE_UPDATER_URL`.

### New

- **auth:** Step-up for one-time sensitive actions (5 minutes) ([9247305](https://github.com/xooxoxxo/tagave/commit/9247305))
- **updates:** Start and follow an in-app update from Settings > Updates ([79c6994](https://github.com/xooxoxxo/tagave/commit/79c6994))

### For self-hosters

- **Migrations:** 0039 auth step up.
- **installer:** --with-updater, enable-updater and disable-updater; docs ([16dffe3](https://github.com/xooxoxxo/tagave/commit/16dffe3))
- **updater:** Opt-in updater service behind the compose profile "updater" ([879c524](https://github.com/xooxoxxo/tagave/commit/879c524))

**All changes:** [v0.7.0...v0.7.1](https://github.com/xooxoxxo/tagave/compare/v0.7.0...v0.7.1)

## [v0.7.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.0) (2026-10-11)

_Generated from the commits; not edited by hand._

**Minor release (0.6 → 0.7).**

### Before you update

- **Going back to 0.6 means a restore.** This update changes the database (migrations 0035–0038). The updater takes a backup first and restores it on its own if the update fails; to return to 0.6 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.7.0/docs/operations.md).
- **Settings in `.env.example`:** added `ALLOWED_ORIGINS`, `TRUST_PROXY`.
- **Settings in `deploy/compose.yml`:** added `ALLOWED_ORIGINS`, `PUBLIC_URL`, `TRUST_PROXY`.

### New

- **auth:** @liner/auth with Better Auth, migration 0035 and the session bridge (L1 wip) ([24e5fa1](https://github.com/xooxoxxo/tagave/commit/24e5fa1))
- **auth:** L1 zero-lockout tests, PUBLIC_URL everywhere, 12-char setup password ([45f4c83](https://github.com/xooxoxxo/tagave/commit/45f4c83))
- **auth:** L3 server side - TOTP, backup codes, revocable trusted devices, reseal ([a7a06ba](https://github.com/xooxoxxo/tagave/commit/a7a06ba))
- **auth:** L4 server side - passkeys and security keys, doctor PUBLIC_URL check ([295a34d](https://github.com/xooxoxxo/tagave/commit/295a34d))
- **review:** Match percent, auto-accept rules, pasted editions ([4c9c190](https://github.com/xooxoxxo/tagave/commit/4c9c190))
- **web:** One page shell, inline back button, contextual Maintenance ([c3a2f4a](https://github.com/xooxoxxo/tagave/commit/c3a2f4a))
- **web:** Raindrop sliding pill for tabs and segmented controls ([f5f5b30](https://github.com/xooxoxxo/tagave/commit/f5f5b30))
- **web:** Pill settles like a small spring, overshoot capped at 3px ([076d336](https://github.com/xooxoxxo/tagave/commit/076d336))
- **web:** Kiosk Home, smooth cover hover, tinted placeholders ([ab81b17](https://github.com/xooxoxxo/tagave/commit/ab81b17))
- **web:** Plan page field filter collapses to one fixed-height line ([033d979](https://github.com/xooxoxxo/tagave/commit/033d979))
- **web:** Fix tags wizard help is a shortcuts popover, not a growing panel ([f9390e4](https://github.com/xooxoxxo/tagave/commit/f9390e4))
- **web:** Album page flow with docking header keys ([365e6d5](https://github.com/xooxoxxo/tagave/commit/365e6d5))
- **web:** L2 sign-in and sign-out on the Better Auth client ([d9e5726](https://github.com/xooxoxxo/tagave/commit/d9e5726))
- **web:** L3 Settings > Security - authenticator app, backup codes, trusted devices, password ([302d827](https://github.com/xooxoxxo/tagave/commit/302d827))
- **web:** L4 passkeys - Security section, passkey sign-in with conditional UI, Protect your account step ([be9eb8e](https://github.com/xooxoxxo/tagave/commit/be9eb8e))
- **web:** Sidebar padding, search placement, wordmark and short-album art settings ([a9dd25f](https://github.com/xooxoxxo/tagave/commit/a9dd25f))
- **web:** Album sections switcher sticks under the header on desktop ([d5f1ab0](https://github.com/xooxoxxo/tagave/commit/d5f1ab0))
- **web:** Review matches compares the edition with what's on disk ([8239dc3](https://github.com/xooxoxxo/tagave/commit/8239dc3))
- Archive finished tag plans; Create plan becomes a plus beside the title ([3226590](https://github.com/xooxoxxo/tagave/commit/3226590))
- Settings > Storage with disk use and tag-change cleanup ([b4045e4](https://github.com/xooxoxxo/tagave/commit/b4045e4))

### Improved

- **web:** Lazy routes, markdown off the album page, one job stream per browser ([6be1b37](https://github.com/xooxoxxo/tagave/commit/6be1b37))
- Precomputed artists list, cheap gap counts, scan-root counts, album detail ([dfeebe4](https://github.com/xooxoxxo/tagave/commit/dfeebe4))

### Fixed

- **api:** Setup-required works without the auth pool (system route tests) ([4051095](https://github.com/xooxoxxo/tagave/commit/4051095))
- **api:** Survive DB connection drops; precompressed, cached static files ([de9c1bc](https://github.com/xooxoxxo/tagave/commit/de9c1bc))
- **api:** Boss test uses pg-boss 12 stop options ([10a5aab](https://github.com/xooxoxxo/tagave/commit/10a5aab))
- **deploy:** Coolify PUBLIC_URL reads the declared SERVICE_URL_APP_3000 ([8072e2b](https://github.com/xooxoxxo/tagave/commit/8072e2b))
- **deploy:** Workers get @liner/auth; manifests copied with their folders ([fdc1235](https://github.com/xooxoxxo/tagave/commit/fdc1235))
- **web:** "Use this edition" waits for the server, then moves the copy once ([b581389](https://github.com/xooxoxxo/tagave/commit/b581389))
- **web:** Give the editions action column a real width ([c32e8f4](https://github.com/xooxoxxo/tagave/commit/c32e8f4))
- **web:** Back after Fix tags no longer reopens the finished wizard ([1328ab0](https://github.com/xooxoxxo/tagave/commit/1328ab0))
- **web:** Tag changes list stacks on phones instead of one letter per line ([337e8f8](https://github.com/xooxoxxo/tagave/commit/337e8f8))
- **web:** Shortcuts popover fits inside the wizard on a phone ([61d5c0b](https://github.com/xooxoxxo/tagave/commit/61d5c0b))
- **web:** Shortcut keys use the kbd radius token ([b5a7399](https://github.com/xooxoxxo/tagave/commit/b5a7399))
- **web:** Kiosk Home fits with its footer; album title reads its own direction ([f6deea0](https://github.com/xooxoxxo/tagave/commit/f6deea0))
- **web:** Album upkeep block takes no room when empty ([f717d08](https://github.com/xooxoxxo/tagave/commit/f717d08))
- **web:** Detail app bar padding and 30px back key; Enriching where the biography lands ([0ec71b3](https://github.com/xooxoxxo/tagave/commit/0ec71b3))
- **web:** Drop the slogan lines ([6f4ab8d](https://github.com/xooxoxxo/tagave/commit/6f4ab8d))
- **web:** Album page on desktop - sections above the tracks, flat header ([fda1ae3](https://github.com/xooxoxxo/tagave/commit/fda1ae3))
- **worker:** Back off retries, keep outages from deferring releases ([37d8c2a](https://github.com/xooxoxxo/tagave/commit/37d8c2a))
- Rr12 merge follow-ups for pg-boss 12 and the page shell contract ([74ca31b](https://github.com/xooxoxxo/tagave/commit/74ca31b))

### For self-hosters

- **Migrations:** 0035 perf indexes artist list, 0036 better auth, 0037 tag plan archive, 0038 auto accept rules.
- Log caps, Postgres sized for the VM, systemd units for split workers ([791e1b2](https://github.com/xooxoxxo/tagave/commit/791e1b2))

**All changes:** [v0.6.1...v0.7.0](https://github.com/xooxoxxo/tagave/compare/v0.6.1...v0.7.0)

## [v0.6.1](https://github.com/xooxoxxo/tagave/releases/tag/v0.6.1) (2026-10-02)

_Generated from the commits; not edited by hand._

**Patch release (0.6.0 → 0.6.1).**

### Before you update

- Nothing to do before this update.

### Fixed

- **ci:** Explicit ifs in the installer test ([10860b9](https://github.com/xooxoxxo/tagave/commit/10860b9))
- **worker:** Replace an album's tracks atomically under a per-album lock ([b817fc3](https://github.com/xooxoxxo/tagave/commit/b817fc3))

**All changes:** [v0.6.0...v0.6.1](https://github.com/xooxoxxo/tagave/compare/v0.6.0...v0.6.1)
