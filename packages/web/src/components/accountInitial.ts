/** The tile's letter: the name's first, else the address's. */
export function accountInitial(name: string, email: string): string {
  const first = [...(name.trim() || email.trim())][0] ?? '?';
  return first.toLocaleUpperCase();
}
