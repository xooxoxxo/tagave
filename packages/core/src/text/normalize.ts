/**
 * Text normalization and string distance functions for album matching.
 * Following spec §12.5: Unicode NFC, case folding, punctuation stripping,
 * leading-article insensitivity, Jaro-Winkler and token-set ratio distances.
 */

/**
 * Normalize a string for comparison: NFC + lowercase + punctuation removal + leading article removal.
 * Matches spec §12.5 normalization rules.
 */
export function normalizeString(s: string): string {
  if (!s) return '';

  // Unicode NFC normalization (canonical composed form)
  let normalized = s.normalize('NFC');

  // Lowercase
  normalized = normalized.toLowerCase();

  // Remove punctuation and extra whitespace
  // Keep only alphanumeric, spaces, and a few allowed characters
  normalized = normalized.replace(/[^\w\s]/gu, '').trim();

  // Collapse multiple spaces into one
  normalized = normalized.replace(/\s+/g, ' ');

  // Remove leading articles ("the", "a", "an")
  normalized = normalized.replace(/^(the|a|an)\s+/i, '').trim();

  return normalized;
}

/**
 * Normalize title specifically (same as normalizeString but used in matching for clarity).
 */
export function normalizeTitle(s: string): string {
  return normalizeString(s);
}

/**
 * Case-insensitive, punctuation-insensitive comparison.
 */
export function compareStrings(a: string, b: string): boolean {
  return normalizeString(a) === normalizeString(b);
}

/**
 * Jaro-Winkler distance: measures similarity of two strings.
 * Returns a value between 0 and 1, where 1 is identical and 0 is completely different.
 * Uses prefix weighting (up to 4 characters) for names/titles.
 *
 * Algorithm: https://en.wikipedia.org/wiki/Jaro%E2%80%93Winkler_distance
 */
export function jaroWinklerDistance(a: string, b: string): number {
  const s1 = a.normalize('NFC').toLowerCase();
  const s2 = b.normalize('NFC').toLowerCase();

  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;

  const len1 = s1.length;
  const len2 = s2.length;
  const matchDistance = Math.max(len1, len2) / 2 - 1;

  const s1Matches = new Array(len1);
  const s2Matches = new Array(len2);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  // Jaro similarity
  const jaro =
    (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) /
    3;

  // Jaro-Winkler: add bonus for common prefix (up to 4 chars)
  let prefixLen = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (s1[i] === s2[i]) prefixLen++;
    else break;
  }

  const scalingFactor = 0.1;
  return jaro + prefixLen * scalingFactor * (1 - jaro);
}

/**
 * Token-set ratio: splits strings into tokens and compares the sorted sets.
 * More tolerant of word order differences than Jaro-Winkler.
 * Returns a value between 0 and 1.
 */
export function tokenSetRatio(a: string, b: string): number {
  const normalize = (s: string) => s.normalize('NFC').toLowerCase();
  const s1 = normalize(a);
  const s2 = normalize(b);

  if (s1 === s2) return 1;

  // Split into tokens and remove duplicates, normalize each token
  const tokenize = (s: string) => {
    const tokens = s.split(/\s+/);
    return [...new Set(tokens.filter((t) => t.length > 0))].sort();
  };

  const tokens1 = tokenize(s1);
  const tokens2 = tokenize(s2);

  // Intersection and union of tokens
  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);
  const intersection = tokens1.filter((t) => set2.has(t)).length;
  const union = new Set([...tokens1, ...tokens2]).size;

  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Combined string distance for matching: weighted average of normalized Jaro-Winkler
 * and token-set ratio. Lower values indicate better matches.
 *
 * Distance is 1 - similarity, so a return of 0 means identical and 1 means completely different.
 * Used for album titles, artist names, etc.
 */
export function stringDistance(a: string, b: string): number {
  const normalized1 = normalizeString(a);
  const normalized2 = normalizeString(b);

  if (normalized1 === normalized2) return 0;
  if (!normalized1 || !normalized2) return 1;

  // Jaro-Winkler returns similarity (1 = match), convert to distance
  const jw = 1 - jaroWinklerDistance(normalized1, normalized2);

  // Token-set ratio also returns similarity, convert to distance
  const tokenSet = 1 - tokenSetRatio(normalized1, normalized2);

  // Weighted average: slightly favor Jaro-Winkler for single-word differences
  return jw * 0.6 + tokenSet * 0.4;
}
