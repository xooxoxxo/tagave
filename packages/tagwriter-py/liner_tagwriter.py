#!/usr/bin/env python3
"""
Liner Mutagen Tag Writer Sidecar
Reads and writes audio metadata via mutagen, communicating via JSON-lines over stdio.
"""

import json
import sys
import os
from pathlib import Path
from typing import Any

from mutagen import File
from mutagen.id3 import ID3
from mutagen.flac import FLAC
from mutagen.oggflac import OggFLAC
from mutagen.oggvorbis import OggVorbis
from mutagen.oggopus import OggOpus
from mutagen.oggtheora import OggTheora
from mutagen.oggspeex import OggSpeex
from mutagen.oggflac import OggFLAC
from mutagen.oggvorbis import OggVorbis
from mutagen.oggopus import OggOpus
from mutagen.wave import WAVE
from mutagen.aiff import AIFF
from mutagen.mp4 import MP4
from mutagen.dsf import DSF
from mutagen.dsdiff import DSDIFF

# Canonical field to format-specific tag mapping per Spec Appendix A
TAG_MAPPING = {
    "title": {
        "id3v24": "TIT2",
        "id3v23": "TIT2",
        "vorbis": "TITLE",
        "mp4": "©nam",
    },
    "artist": {
        "id3v24": "TPE1",
        "id3v23": "TPE1",
        "vorbis": "ARTIST",
        "mp4": "©ART",
    },
    "artistsort": {
        "id3v24": "TSOP",
        "id3v23": "TSOP",
        "vorbis": "ARTISTSORT",
        "mp4": "soar",
    },
    "album": {
        "id3v24": "TALB",
        "id3v23": "TALB",
        "vorbis": "ALBUM",
        "mp4": "©alb",
    },
    "albumartist": {
        "id3v24": "TPE2",
        "id3v23": "TPE2",
        "vorbis": "ALBUMARTIST",
        "mp4": "aART",
    },
    "albumartistsort": {
        "id3v24": "TSO2",
        "id3v23": "TSO2",
        "vorbis": "ALBUMARTISTSORT",
        "mp4": "soaa",
    },
    "date": {
        "id3v24": "TDRC",
        "id3v23": ["TYER", "TDAT"],
        "vorbis": "DATE",
        "mp4": "©day",
    },
    "originaldate": {
        "id3v24": "TDOR",
        "id3v23": "TORY",
        "vorbis": "ORIGINALDATE",
        "mp4": "----:com.apple.iTunes:ORIGINALDATE",
    },
    "tracknumber": {
        "id3v24": "TRCK",
        "id3v23": "TRCK",
        "vorbis": "TRACKNUMBER",
        "mp4": "trkn",
    },
    "totaltracks": {
        "id3v24": "TRCK",
        "id3v23": "TRCK",
        "vorbis": ["TRACKTOTAL", "TOTALTRACKS"],
        "mp4": "trkn",
    },
    "discnumber": {
        "id3v24": "TPOS",
        "id3v23": "TPOS",
        "vorbis": "DISCNUMBER",
        "mp4": "disk",
    },
    "totaldiscs": {
        "id3v24": "TPOS",
        "id3v23": "TPOS",
        "vorbis": ["DISCTOTAL", "TOTALDISCS"],
        "mp4": "disk",
    },
    "discsubtitle": {
        "id3v24": "TSST",
        "id3v23": None,
        "vorbis": "DISCSUBTITLE",
        "mp4": "----:com.apple.iTunes:DISCSUBTITLE",
    },
    "genre": {
        "id3v24": "TCON",
        "id3v23": "TCON",
        "vorbis": "GENRE",
        "mp4": "©gen",
    },
    "label": {
        "id3v24": "TPUB",
        "id3v23": "TPUB",
        "vorbis": "LABEL",
        "mp4": "----:com.apple.iTunes:LABEL",
    },
    "catalognumber": {
        "id3v24": "TXXX:CATALOGNUMBER",
        "id3v23": "TXXX:CATALOGNUMBER",
        "vorbis": "CATALOGNUMBER",
        "mp4": "----:com.apple.iTunes:CATALOGNUMBER",
    },
    "barcode": {
        "id3v24": "TXXX:BARCODE",
        "id3v23": "TXXX:BARCODE",
        "vorbis": "BARCODE",
        "mp4": "----:com.apple.iTunes:BARCODE",
    },
    "media": {
        "id3v24": "TMED",
        "id3v23": "TMED",
        "vorbis": "MEDIA",
        "mp4": "----:com.apple.iTunes:MEDIA",
    },
    "releasecountry": {
        "id3v24": "TXXX:MusicBrainz Album Release Country",
        "id3v23": "TXXX:MusicBrainz Album Release Country",
        "vorbis": "RELEASECOUNTRY",
        "mp4": "----:com.apple.iTunes:MusicBrainz Album Release Country",
    },
    "releasestatus": {
        "id3v24": "TXXX:MusicBrainz Album Status",
        "id3v23": "TXXX:MusicBrainz Album Status",
        "vorbis": "RELEASESTATUS",
        "mp4": "----:com.apple.iTunes:MusicBrainz Album Status",
    },
    "releasetype": {
        "id3v24": "TXXX:MusicBrainz Album Type",
        "id3v23": "TXXX:MusicBrainz Album Type",
        "vorbis": "RELEASETYPE",
        "mp4": "----:com.apple.iTunes:MusicBrainz Album Type",
    },
    "compilation": {
        "id3v24": "TCMP",
        "id3v23": "TCMP",
        "vorbis": "COMPILATION",
        "mp4": "cpil",
    },
    "isrc": {
        "id3v24": "TSRC",
        "id3v23": "TSRC",
        "vorbis": "ISRC",
        "mp4": "----:com.apple.iTunes:ISRC",
    },
    "musicbrainz_albumid": {
        "id3v24": "TXXX:MusicBrainz Album Id",
        "id3v23": "TXXX:MusicBrainz Album Id",
        "vorbis": "MUSICBRAINZ_ALBUMID",
        "mp4": "----:com.apple.iTunes:MusicBrainz Album Id",
    },
    "musicbrainz_releasegroupid": {
        "id3v24": "TXXX:MusicBrainz Release Group Id",
        "id3v23": "TXXX:MusicBrainz Release Group Id",
        "vorbis": "MUSICBRAINZ_RELEASEGROUPID",
        "mp4": "----:com.apple.iTunes:MusicBrainz Release Group Id",
    },
    "musicbrainz_albumartistid": {
        "id3v24": "TXXX:MusicBrainz Album Artist Id",
        "id3v23": "TXXX:MusicBrainz Album Artist Id",
        "vorbis": "MUSICBRAINZ_ALBUMARTISTID",
        "mp4": "----:com.apple.iTunes:MusicBrainz Album Artist Id",
    },
    "musicbrainz_artistid": {
        "id3v24": "TXXX:MusicBrainz Artist Id",
        "id3v23": "TXXX:MusicBrainz Artist Id",
        "vorbis": "MUSICBRAINZ_ARTISTID",
        "mp4": "----:com.apple.iTunes:MusicBrainz Artist Id",
    },
    "musicbrainz_recordingid": {
        "id3v24": "UFID:http://musicbrainz.org",
        "id3v23": "UFID:http://musicbrainz.org",
        "vorbis": "MUSICBRAINZ_TRACKID",
        "mp4": "----:com.apple.iTunes:MusicBrainz Track Id",
    },
    "musicbrainz_releasetrackid": {
        "id3v24": "TXXX:MusicBrainz Release Track Id",
        "id3v23": "TXXX:MusicBrainz Release Track Id",
        "vorbis": "MUSICBRAINZ_RELEASETRACKID",
        "mp4": "----:com.apple.iTunes:MusicBrainz Release Track Id",
    },
    "acoustid_id": {
        "id3v24": "TXXX:Acoustid Id",
        "id3v23": "TXXX:Acoustid Id",
        "vorbis": "ACOUSTID_ID",
        "mp4": "----:com.apple.iTunes:Acoustid Id",
    },
    "discogs_release_id": {
        "id3v24": "TXXX:DISCOGS_RELEASE_ID",
        "id3v23": "TXXX:DISCOGS_RELEASE_ID",
        "vorbis": "DISCOGS_RELEASE_ID",
        "mp4": "----:com.apple.iTunes:DISCOGS_RELEASE_ID",
    },
    "discogs_master_id": {
        "id3v24": "TXXX:DISCOGS_MASTER_ID",
        "id3v23": "TXXX:DISCOGS_MASTER_ID",
        "vorbis": "DISCOGS_MASTER_ID",
        "mp4": "----:com.apple.iTunes:DISCOGS_MASTER_ID",
    },
}

# Multi-valued fields that should be repeated or separated, not concatenated
MULTI_VALUE_FIELDS = {
    "artist",
    "genre",
    "releasetype",
    "musicbrainz_albumartistid",
    "musicbrainz_artistid",
}


def get_container_type(path: str) -> str:
    """Determine the audio container type from file extension."""
    ext = Path(path).suffix.lower()
    return ext.lstrip(".")


def detect_tag_format(path: str) -> str:
    """
    Detect which tag format is used by the file.
    Returns: 'id3v24', 'id3v23', 'vorbis', 'mp4', 'ape', 'dsf', 'dff', 'wav', 'aiff'
    """
    container = get_container_type(path)

    if container == "mp3":
        # Check ID3 version
        try:
            tags = ID3(path)
            # ID3v2.4 is the default for mutagen
            return "id3v24"
        except:
            return "id3v24"

    elif container in ("flac",):
        return "vorbis"

    elif container in ("ogg", "oga"):
        # Could be vorbis or opus
        try:
            audio = File(path)
            if isinstance(audio, OggOpus):
                return "vorbis"  # Opus also uses Vorbis comment
            return "vorbis"
        except:
            return "vorbis"

    elif container in ("m4a", "m4b", "m4p", "alac"):
        return "mp4"

    elif container in ("wv",):
        return "ape"

    elif container in ("ape",):
        return "ape"

    elif container in ("wav",):
        return "wav"

    elif container in ("aiff", "aif"):
        return "aiff"

    elif container in ("dsf",):
        return "dsf"

    elif container in ("dff",):
        return "dff"

    else:
        # Default to vorbis for unknown formats
        return "vorbis"


# ---------------------------------------------------------------------------
# Tag families. WAV / AIFF / DSF / DFF carry ID3 like MP3; FLAC + Ogg carry
# Vorbis comments; MP4 carries atoms + iTunes freeform; APE / WavPack are
# read-only in v1 (spec TAG-1: APEv2 mapping is P1, corpus not validated).
# ---------------------------------------------------------------------------
ID3_CONTAINERS = {"mp3", "wav", "aiff", "aif", "dsf", "dff"}
VORBIS_CONTAINERS = {"flac", "ogg", "oga", "opus", "spx"}
MP4_CONTAINERS = {"m4a", "m4b", "m4p", "alac", "mp4"}
APE_CONTAINERS = {"ape", "wv", "mpc", "tta", "ofr"}
# frames / keys that must never be rewritten or stripped (embedded art, binary blobs)
ID3_PROTECTED_PREFIXES = ("APIC", "PIC", "GEOB", "PRIV", "MCDI", "AENC", "ASPI", "SEEK", "SIGN", "RVA2", "EQU2", "RBUF", "OWNE", "USER", "GRID", "POSS")
VORBIS_PROTECTED = {"METADATA_BLOCK_PICTURE", "COVERART", "COVERARTMIME"}
MP4_PROTECTED = {"covr"}


def tag_family(path: str) -> str:
    c = get_container_type(path)
    if c in ID3_CONTAINERS:
        return "id3"
    if c in VORBIS_CONTAINERS:
        return "vorbis"
    if c in MP4_CONTAINERS:
        return "mp4"
    if c in APE_CONTAINERS:
        return "ape"
    return "vorbis"


def mapping_key(family: str, id3_version: str) -> str:
    if family == "id3":
        return "id3v23" if str(id3_version) == "2.3" else "id3v24"
    return family


def _split_pair(text: str) -> tuple[str | None, str | None]:
    """'3/12' -> ('3', '12'); '3' -> ('3', None)."""
    if text is None:
        return None, None
    t = str(text)
    if "/" in t:
        a, b = t.split("/", 1)
        return (a.strip() or None), (b.strip() or None)
    return (t.strip() or None), None


def _native_from_id3(tags) -> dict[str, list[str]]:
    native: dict[str, list[str]] = {}
    if tags is None:
        return native
    for frame in tags.values():
        fid = frame.FrameID
        if fid == "TXXX":
            native[f"TXXX:{frame.desc}"] = [str(t) for t in frame.text]
        elif fid == "UFID":
            native[f"UFID:{frame.owner}"] = [frame.data.decode("utf-8", "replace")]
        elif fid.startswith(ID3_PROTECTED_PREFIXES):
            native[frame.HashKey] = ["<binary>"]
        elif hasattr(frame, "text"):
            native[fid] = [str(t) for t in frame.text]
        else:
            native[frame.HashKey] = ["<binary>"]
    return native


def _native_from_vorbis(tags) -> dict[str, list[str]]:
    native: dict[str, list[str]] = {}
    if tags is None:
        return native
    for key, value in tags.items():
        k = key.upper()
        vals = [str(v) for v in value] if isinstance(value, (list, tuple)) else [str(value)]
        native.setdefault(k, []).extend(vals)
    return native


def _native_from_mp4(tags) -> dict[str, list[str]]:
    native: dict[str, list[str]] = {}
    if tags is None:
        return native
    for key, value in tags.items():
        if key in MP4_PROTECTED:
            native[key] = ["<binary>"]
            continue
        if key in ("trkn", "disk"):
            pairs = value if isinstance(value, list) else [value]
            n, total = (pairs[0] if pairs else (0, 0))
            native[key] = [f"{n}/{total}" if total else str(n)]
            continue
        if key == "cpil":
            native[key] = ["1" if value else "0"]
            continue
        vals = value if isinstance(value, list) else [value]
        out = []
        for v in vals:
            if isinstance(v, bytes):
                out.append(v.decode("utf-8", "replace"))
            else:
                out.append(str(v))
        native[key] = out
    return native


def read_tags(path: str) -> dict[str, Any]:
    """Canonical TagSet for a file; unmapped native tags under __unknown__."""
    try:
        audio = File(path)
        if audio is None:
            return {}
        family = tag_family(path)
        if family == "id3":
            native = _native_from_id3(getattr(audio, "tags", None))
            key = "id3v24"
        elif family == "vorbis":
            native = _native_from_vorbis(getattr(audio, "tags", None))
            key = "vorbis"
        elif family == "mp4":
            native = _native_from_mp4(getattr(audio, "tags", None))
            key = "mp4"
        else:
            return {"__error__": f"{family} files are read-only in v1"}

        canonical: dict[str, Any] = {}
        seen: set[str] = set()
        for field, mapping in TAG_MAPPING.items():
            names = mapping.get(key)
            if not names:
                continue
            if not isinstance(names, list):
                names = [names]
            values: list[str] = []
            for n in names:
                if n in native:
                    seen.add(n)
                    values.extend(native[n])
            if not values and field in ("totaltracks", "totaldiscs") and key == "vorbis":
                # some taggers write "3/12" into TRACKNUMBER without a TRACKTOTAL
                src = TAG_MAPPING["tracknumber" if field == "totaltracks" else "discnumber"]["vorbis"]
                _, second = _split_pair((native.get(src) or [None])[0])
                if second is not None:
                    canonical[field] = second
                continue
            if not values:
                continue
            # TRCK / TPOS / trkn / disk carry two canonical fields; Vorbis keys are separate
            if field in ("tracknumber", "totaltracks", "discnumber", "totaldiscs"):
                first, second = _split_pair(values[0])
                if key == "vorbis":
                    want = first if field in ("tracknumber", "discnumber") else (values[0].strip() or None)
                else:
                    want = first if field in ("tracknumber", "discnumber") else second
                if want is not None:
                    canonical[field] = want
                continue
            if field == "compilation":
                canonical[field] = values[0] in ("1", "True", "true")
                continue
            if field in MULTI_VALUE_FIELDS:
                canonical[field] = values if len(values) > 1 else values[0]
            else:
                canonical[field] = "; ".join(values) if len(values) > 1 else values[0]

        unknown = {k: (v if len(v) > 1 else v[0]) for k, v in native.items() if k not in seen}
        if unknown:
            canonical["__unknown__"] = unknown
        return canonical
    except Exception as e:  # never crash the sidecar on one file
        return {"__error__": str(e)}


def _values_for(field: str, value: Any, separator: str, joined: bool) -> list[str]:
    if isinstance(value, bool):
        return ["1" if value else "0"]
    vals = value if isinstance(value, list) else [value]
    vals = [str(v) for v in vals if v is not None and str(v) != ""]
    if field in MULTI_VALUE_FIELDS and not joined:
        return vals
    return [separator.join(vals)] if len(vals) > 1 else vals


def write_tags(path: str, tags: dict[str, Any], options: dict[str, Any]) -> None:
    """Write the given canonical fields; every other tag and all embedded art
    stay untouched (stripUnknown=True removes unmapped *text* tags only)."""
    family = tag_family(path)
    if family == "ape":
        raise ValueError(f"{get_container_type(path)} files are read-only in v1 (TAG-1)")
    audio = File(path)
    if audio is None:
        raise ValueError(f"Could not open audio file: {path}")
    id3_version = str(options.get("id3Version", "2.4"))
    separator = str(options.get("multiValueSeparator", "; "))
    strip_unknown = bool(options.get("stripUnknown", False))
    key = mapping_key(family, id3_version)
    joined = key == "id3v23"  # v2.3 has no multi-value convention

    requested = {k: v for k, v in tags.items() if not k.startswith("__") and v is not None}

    # tracknumber/totaltracks and discnumber/totaldiscs share one native tag
    existing = read_tags(path)
    def pair(num_field: str, total_field: str) -> str | None:
        if num_field not in requested and total_field not in requested:
            return None
        n = requested.get(num_field, existing.get(num_field))
        t = requested.get(total_field, existing.get(total_field))
        if n is None and t is None:
            return None
        return f"{n or ''}/{t}" if t else str(n)

    native: dict[str, list[str]] = {}
    number_fields = ("tracknumber", "totaltracks", "discnumber", "totaldiscs")
    for field, value in requested.items():
        if field in number_fields:
            if family == "vorbis":
                # Vorbis comments keep numbers in separate keys (TRACKNUMBER +
                # TRACKTOTAL/TOTALTRACKS); write every alias so all players agree.
                names = TAG_MAPPING[field]["vorbis"]
                for n in (names if isinstance(names, list) else [names]):
                    native[n] = [str(value)]
            continue
        mapping = TAG_MAPPING.get(field)
        if not mapping:
            continue  # not a canonical field for this writer
        name = mapping.get(key)
        if not name:
            continue
        if isinstance(name, list):
            name = name[0]
        native[name] = _values_for(field, value, separator, joined)
    trk = pair("tracknumber", "totaltracks") if family != "vorbis" else None
    dsc = pair("discnumber", "totaldiscs") if family != "vorbis" else None
    if trk is not None:
        native[TAG_MAPPING["tracknumber"][key] if not isinstance(TAG_MAPPING["tracknumber"][key], list) else TAG_MAPPING["tracknumber"][key][0]] = [trk]
    if dsc is not None:
        native[TAG_MAPPING["discnumber"][key] if not isinstance(TAG_MAPPING["discnumber"][key], list) else TAG_MAPPING["discnumber"][key][0]] = [dsc]

    mapped_names = set()
    for field, mapping in TAG_MAPPING.items():
        n = mapping.get(key)
        if n:
            mapped_names.update(n if isinstance(n, list) else [n])

    if family == "id3":
        from mutagen.id3 import Frames, TXXX, UFID
        if getattr(audio, "tags", None) is None:
            audio.add_tags()
        id3 = audio.tags
        for name, vals in native.items():
            if name.startswith("TXXX:"):
                desc = name[5:]
                id3.delall(f"TXXX:{desc}")
                id3.add(TXXX(encoding=3, desc=desc, text=vals))
            elif name.startswith("UFID:"):
                owner = name[5:]
                id3.delall(f"UFID:{owner}")
                id3.add(UFID(owner=owner, data=vals[0].encode("utf-8")))
            else:
                cls = Frames.get(name)
                if cls is None:
                    continue
                id3.delall(name)
                id3.add(cls(encoding=3, text=vals))
        if strip_unknown:
            for hk in list(id3.keys()):
                fid = hk.split(":", 1)[0]
                if hk in mapped_names or fid.startswith(ID3_PROTECTED_PREFIXES):
                    continue
                if fid.startswith("T") or fid in ("UFID", "COMM", "USLT", "WXXX"):
                    id3.delall(hk)
        v2 = 3 if id3_version == "2.3" else 4
        try:
            audio.save(v2_version=v2, v23_sep=separator)
        except TypeError:
            audio.save()
        return

    if family == "vorbis":
        if getattr(audio, "tags", None) is None:
            audio.add_tags()
        vc = audio.tags
        for name, vals in native.items():
            vc[name.upper()] = vals
        if strip_unknown:
            for k in list({k.upper() for k, _ in vc.items()}):
                if k not in {m.upper() for m in mapped_names} and k not in VORBIS_PROTECTED:
                    del vc[k]
        audio.save()
        return

    if family == "mp4":
        from mutagen.mp4 import MP4FreeForm
        if getattr(audio, "tags", None) is None:
            audio.add_tags()
        mp4 = audio.tags
        for name, vals in native.items():
            if name in ("trkn", "disk"):
                n, t = _split_pair(vals[0])
                mp4[name] = [(int(n or 0), int(t or 0))]
            elif name == "cpil":
                mp4[name] = vals[0] in ("1", "True", "true")
            elif name.startswith("----:"):
                mp4[name] = [MP4FreeForm(v.encode("utf-8")) for v in vals]
            else:
                mp4[name] = vals
        if strip_unknown:
            for k in list(mp4.keys()):
                if k not in mapped_names and k not in MP4_PROTECTED:
                    del mp4[k]
        audio.save()
        return

    raise ValueError(f"Unsupported tag family for {path}")


def supports(container: str) -> bool:
    """Check if the container format is supported for writing."""
    container_lower = container.lower().lstrip(".")

    # APE and WavPack are read-only in v1
    if container_lower in ("ape", "wv"):
        return False

    # DSF and DFF write support deferred
    if container_lower in ("dsf", "dff"):
        return False

    # All other formats are supported
    return container_lower in (ID3_CONTAINERS | VORBIS_CONTAINERS | MP4_CONTAINERS)


def handle_json_command(req: dict) -> str:
    """JSON-lines protocol: {"op": "read"|"write"|"supports", "path", "tags", "options", "container"}.
    Payloads travel as JSON, never through shell-style tokenising (shlex stripped the
    quotes out of the tags object and every write failed)."""
    op = req.get("op")
    if op == "read":
        path = req.get("path")
        if not path:
            return json.dumps({"error": "read requires a path"})
        return json.dumps(read_tags(path))
    if op == "write":
        path = req.get("path")
        if not path:
            return json.dumps({"error": "write requires a path"})
        tags_json = req.get("tags") or {}
        options_json = req.get("options") or {}
        if not isinstance(tags_json, dict) or not isinstance(options_json, dict):
            return json.dumps({"error": "write expects tags and options objects"})
        try:
            write_tags(path, tags_json, options_json)
            return json.dumps({"success": True})
        except Exception as e:  # surfaced to the caller as write_failed
            return json.dumps({"error": str(e)})
    if op == "supports":
        container = req.get("container")
        if not container:
            return json.dumps({"error": "supports requires a container"})
        return json.dumps({"supported": supports(container)})
    return json.dumps({"error": f"Unknown op: {op}"})


def handle_command(line: str) -> str:
    """Handle a single command from stdin (JSON object preferred; legacy text form kept)."""
    try:
        stripped = line.strip()
        if stripped.startswith("{"):
            try:
                req = json.loads(stripped)
            except json.JSONDecodeError as e:
                return json.dumps({"error": f"Invalid JSON command: {str(e)}"})
            if isinstance(req, dict):
                return handle_json_command(req)
            return json.dumps({"error": "Command must be a JSON object"})

        parts = stripped.split(None, 1)
        if not parts:
            return json.dumps({"error": "Empty command"})

        command = parts[0]

        if command == "read":
            if len(parts) < 2:
                return json.dumps({"error": "read requires a path"})
            path = parts[1]
            tags = read_tags(path)
            return json.dumps(tags)

        elif command == "write":
            if len(parts) < 2:
                return json.dumps({"error": "write requires a path"})
            # Parse: write <path> <json_encoded_tags> <json_encoded_options>
            remaining = parts[1]
            # Split by spaces but respect quoted strings
            import shlex

            try:
                parsed = shlex.split(remaining)
                if len(parsed) < 1:
                    return json.dumps({"error": "write requires a path"})
                path = parsed[0]
                tags_json = json.loads(parsed[1]) if len(parsed) > 1 else {}
                options_json = json.loads(parsed[2]) if len(parsed) > 2 else {}
            except (json.JSONDecodeError, IndexError) as e:
                return json.dumps({"error": f"Invalid write command: {str(e)}"})

            try:
                write_tags(path, tags_json, options_json)
                return json.dumps({"success": True})
            except Exception as e:
                return json.dumps({"error": str(e)})

        elif command == "supports":
            if len(parts) < 2:
                return json.dumps({"error": "supports requires a container"})
            container = parts[1]
            return json.dumps({"supported": supports(container)})

        else:
            return json.dumps({"error": f"Unknown command: {command}"})

    except Exception as e:
        return json.dumps({"error": f"Exception handling command: {str(e)}"})


def main():
    """Main loop: read commands from stdin, output JSON-lines to stdout."""
    sys.stderr.write("Liner tagwriter sidecar started\n")
    sys.stderr.flush()

    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                # EOF
                break

            response = handle_command(line)
            print(response)
            sys.stdout.flush()

        except KeyboardInterrupt:
            break
        except Exception as e:
            error_response = json.dumps({"error": f"Unexpected error: {str(e)}"})
            print(error_response)
            sys.stdout.flush()


if __name__ == "__main__":
    main()
