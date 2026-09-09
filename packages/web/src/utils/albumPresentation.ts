/** Preserve provider spelling and order while suppressing duplicate genre labels. */
export function uniqueGenres(...sources: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  return sources.flatMap(source => source ?? []).filter(label => {
    const key = label.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(label => label.trim());
}
