# Lidarr staging contract for FLAC upgrades

An isolated Lidarr HTTP fixture verified the existing client’s request, progress, and import flow. Tagave mapped the worker’s `/worker/music/_Inbox` to Lidarr’s `/lidarr/music/_Inbox`. A new artist used the selected profile and that root. The queue reported 75% downloaded. The returned track paths mapped back under the worker’s drop pool.

The fixture also confirmed the existing Get flow searches a monitored album without replacing its artist’s path or profile. Changing the fixture to an artist outside the staging root with another profile did not stop the search. The upgrade flow must check both before it sends a command. It must refuse an existing artist or imported track file outside the mapped staging folder. It must never move a Lidarr artist or change its profile to make the request fit.

Require a reachable mapped drop pool and a profile that allows FLAC for the upgrade. A profile name or Lidarr’s import status does not prove format or completeness. Use the reported track files to locate the staged download, then read the files on the music worker and verify the codec and edition. Record any existing import before searching so it cannot be mistaken for the requested download.

This verified the client contract and its safety boundary with a fixture. Actual download and import behavior depends on the installed Lidarr build, quality profile, indexer, and download client. [Lidarr API](https://lidarr.audio/docs/api/)
