/**
 * Formatting utilities for display
 */

/**
 * Format bytes as human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

/**
 * Format seconds as duration string
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }

  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Format ISO datetime to local string
 */
export function formatDateTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return isoString;
  }
}

/**
 * Format bitrate in kbps or Mbps
 */
export function formatBitrate(bps: number): string {
  if (bps < 1000000) {
    return `${Math.round(bps / 1000)} kbps`;
  }
  return `${(bps / 1000000).toFixed(1)} Mbps`;
}

/**
 * Format sample rate
 */
export function formatSampleRate(hz: number): string {
  return `${hz / 1000}kHz`;
}

/**
 * Get codec display name
 */
export function getCodecName(codec: string): string {
  const names: Record<string, string> = {
    flac: 'FLAC',
    mp3: 'MP3',
    aac: 'AAC',
    alac: 'ALAC',
    opus: 'Opus',
    vorbis: 'Vorbis',
    wav: 'WAV',
    aiff: 'AIFF',
    ape: 'Monkey\'s Audio',
    wv: 'WavPack',
    dsd: 'DSD',
  };
  return names[codec.toLowerCase()] || codec.toUpperCase();
}

/**
 * Get container display name
 */
export function getContainerName(container: string): string {
  const names: Record<string, string> = {
    flac: 'FLAC',
    mp3: 'MP3',
    m4a: 'M4A',
    mp4: 'MP4',
    ogg: 'OGG',
    opus: 'Opus',
    wav: 'WAV',
    aiff: 'AIFF',
    ape: 'APE',
    wv: 'WavPack',
    dsf: 'DSF',
    dff: 'DFF',
  };
  return names[container.toLowerCase()] || container.toUpperCase();
}
