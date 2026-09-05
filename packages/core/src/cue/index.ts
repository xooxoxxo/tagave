/**
 * CUE sheet parsing and virtual track extraction
 * spec XO-314
 */

export { decodeCueBytes, parseCueSheet } from './parse.js';
export type { CueSheet, CueFile, CueTrack } from './parse.js';

export { virtualTracksForFile } from './virtual.js';
export type { VirtualTrack } from './virtual.js';

export { matchCueFileToAudio, chooseCueForAudio } from './match.js';
export type { CueCandidate, MatchResult } from './match.js';
