/**
 * Audio format classification utilities
 */

import { AudioFile } from '../types/index';

/**
 * Determine if a file is lossless based on codec
 */
export function isLossless(codec: string): boolean {
  const losslessCodecs = ['flac', 'alac', 'ape', 'wv', 'dsd'];
  return losslessCodecs.includes(codec.toLowerCase());
}

/**
 * Determine if a file is lossy
 */
export function isLossy(codec: string): boolean {
  const lossyCodecs = ['mp3', 'aac', 'opus', 'vorbis'];
  return lossyCodecs.includes(codec.toLowerCase());
}

/**
 * Get quality indicator for a file
 */
export function getQualityIndicator(file: AudioFile): 'high' | 'medium' | 'low' {
  if (isLossless(file.codec)) {
    return 'high';
  }

  // For lossy, use bitrate
  if (file.averageBitrate >= 256000) {
    return 'high';
  }
  if (file.averageBitrate >= 192000) {
    return 'medium';
  }
  return 'low';
}

/**
 * Check if a file has a quality concern
 */
export function hasQualityConcern(file: AudioFile): boolean {
  if (isLossy(file.codec) && file.averageBitrate < 192000) {
    return true;
  }
  return false;
}

/**
 * Determine if a container format supports tag writing in v1
 */
export function supportsTagWriting(container: string): boolean {
  // Per spec LIB-2: v1 writes to ID3, Vorbis-comment, MP4 families
  // APE/WavPack are read-only until TAG-1's APEv2 mapping ships (P1)
  const writableContainers = [
    'flac',    // Vorbis comments
    'mp3',     // ID3v2
    'ogg',     // Vorbis comments
    'opus',    // Vorbis comments
    'wav',     // ID3v2 chunk
    'aiff',    // ID3v2 chunk
    'dsf',     // ID3v2 at end
    'dff',     // ID3v2 chunk
    'm4a',     // MP4 atoms
    'mp4',     // MP4 atoms
  ];
  return writableContainers.includes(container.toLowerCase());
}

/**
 * Check if bitrate is below recommended minimum
 */
export function isBitrateLow(codec: string, bitrate: number, threshold = 192000): boolean {
  // Only applies to lossy formats
  if (isLossless(codec)) return false;
  return bitrate < threshold;
}
