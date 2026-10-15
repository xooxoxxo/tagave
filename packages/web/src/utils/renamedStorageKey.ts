/**
 * Browser storage keys were named liner.* before 0.9. Moves a value kept
 * under an old key to its new key once (read old, write new unless the new
 * key already holds something, delete old), so a preference or a selection
 * survives the update and the old key never comes back. Storage that throws
 * (blocked, private mode) is left alone.
 */
export function migrateStorageKey(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, oldKey: string, newKey: string): void {
  try {
    const old = storage.getItem(oldKey);
    if (old === null) return;
    if (storage.getItem(newKey) === null) storage.setItem(newKey, old);
    storage.removeItem(oldKey);
  } catch {
    /* storage blocked: nothing to move */
  }
}
