/**
 * Reserved `app_settings` key prefix for the per-KB generation counter (RET-02). Shared by both
 * `SqliteStorageDriver` and `PgStorageDriver` (plan 03-05, D3-09) — the two dialects must agree on
 * the exact key string or switching `DATABASE_URL` on/off for the same buyer would silently reset
 * the counter and force an unnecessary full index rebuild. Never collides with a caller-supplied
 * `setSetting`/`getSetting` key because callers own arbitrary strings and this prefix is only ever
 * written internally.
 */
export function generationKey(kbId: string): string {
  return `__generation__:${kbId}`;
}
