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
from mutagen.oggspeeches import OggSpeech
from mutagen.oggflac import OggFLAC
from mutagen.oggvorbis import OggVorbis
from mutagen.oggopus import OggOpus
from mutagen.wave import WAVE
from mutagen.aiff import AIFF
from mutagen.mp4 import MP4
from mutagen.dsf import DSF
from mutagen.dsdiff import DSDiff

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


def read_tags(path: str) -> dict[str, Any]:
    """
    Read tags from an audio file and return them as a canonical TagSet.
    Unknown tags are preserved.
    """
    try:
        audio = File(path)
        if audio is None:
            return {}

        canonical_tags: dict[str, Any] = {}
        unknown_tags: dict[str, Any] = {}

        tag_format = detect_tag_format(path)
        all_tags: dict[str, Any] = {}

        # Extract all tags from the audio file
        if isinstance(audio, dict) and hasattr(audio, "items"):
            all_tags = dict(audio)
        else:
            all_tags = dict(audio) if hasattr(audio, "__iter__") else {}

        # Track which tags we've seen to identify unknowns
        seen_native_tags = set()

        # Map native tags back to canonical fields
        for canonical_field, field_mapping in TAG_MAPPING.items():
            native_tag_names = field_mapping.get(tag_format)
            if not native_tag_names:
                continue

            if not isinstance(native_tag_names, list):
                native_tag_names = [native_tag_names]

            values = []
            for native_tag in native_tag_names:
                if native_tag in all_tags:
                    seen_native_tags.add(native_tag)
                    value = all_tags[native_tag]
                    # Handle mutagen's complex types
                    if isinstance(value, (list, tuple)):
                        values.extend([str(v) for v in value])
                    else:
                        values.append(str(value))

            if values:
                # Join or keep as array depending on field type
                if canonical_field in MULTI_VALUE_FIELDS:
                    canonical_tags[canonical_field] = (
                        values if len(values) > 1 else values[0] if values else None
                    )
                else:
                    canonical_tags[canonical_field] = "; ".join(values) if len(values) > 1 else values[0]

        # Collect unknown tags
        for native_tag, value in all_tags.items():
            if native_tag not in seen_native_tags:
                if isinstance(value, (list, tuple)):
                    unknown_tags[native_tag] = [str(v) for v in value]
                else:
                    unknown_tags[native_tag] = str(value)

        if unknown_tags:
            canonical_tags["__unknown__"] = unknown_tags

        return canonical_tags

    except Exception as e:
        return {"__error__": str(e)}


def write_tags(path: str, tags: dict[str, Any], options: dict[str, Any]) -> None:
    """
    Write tags to an audio file.
    Respects stripUnknown option and preserves unknown tags by default.
    """
    try:
        audio = File(path)
        if audio is None:
            audio = File(path, easy=False)
            if audio is None:
                raise ValueError(f"Could not open audio file: {path}")

        tag_format = detect_tag_format(path)
        id3_version = options.get("id3Version", "2.4")
        multi_value_separator = options.get("multiValueSeparator", "; ")
        strip_unknown = options.get("stripUnknown", False)

        # Prepare native tags to write
        native_tags: dict[str, Any] = {}

        # First, preserve existing unknown tags unless stripping
        if not strip_unknown:
            existing_unknown = read_tags(path).get("__unknown__", {})
            for native_tag, value in existing_unknown.items():
                native_tags[native_tag] = value

        # Convert canonical tags to native format
        for canonical_field, value in tags.items():
            if canonical_field == "__unknown__" or canonical_field == "__error__":
                continue

            if value is None:
                continue

            field_mapping = TAG_MAPPING.get(canonical_field)
            if not field_mapping:
                # Unknown canonical field, preserve as-is
                native_tags[canonical_field] = value
                continue

            native_tag_names = field_mapping.get(tag_format)
            if not native_tag_names:
                continue

            if not isinstance(native_tag_names, list):
                native_tag_names = [native_tag_names]

            # Handle multi-value fields
            if canonical_field in MULTI_VALUE_FIELDS:
                if isinstance(value, list):
                    values = value
                else:
                    values = [value]
            else:
                if isinstance(value, list):
                    values = [multi_value_separator.join(value)]
                else:
                    values = [value]

            # Write to the first native tag name
            native_tag = native_tag_names[0]
            if tag_format == "id3v24" or tag_format == "id3v23":
                native_tags[native_tag] = values if len(values) > 1 else values[0]
            else:
                native_tags[native_tag] = values if len(values) > 1 else values[0]

        # Clear existing tags
        if hasattr(audio, "delete"):
            audio.delete()
        elif hasattr(audio, "clear"):
            audio.clear()

        # Set new tags
        for native_tag, value in native_tags.items():
            audio[native_tag] = value

        # Handle ID3 version for MP3 files
        if tag_format == "id3v24" or tag_format == "id3v23":
            if hasattr(audio, "save"):
                if id3_version == "2.3":
                    audio.save(v2_version=3)
                else:
                    audio.save(v2_version=4)
            else:
                audio.save()
        else:
            audio.save()

    except Exception as e:
        raise ValueError(f"Failed to write tags to {path}: {str(e)}")


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
    return container_lower in ("mp3", "flac", "ogg", "oga", "m4a", "m4b", "m4p", "alac", "wav", "aiff", "aif")


def handle_command(line: str) -> str:
    """Handle a single command from stdin."""
    try:
        parts = line.strip().split(None, 1)
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
