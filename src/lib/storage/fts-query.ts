/**
 * `sanitizeFtsQuery` — moved here from `src/lib/retrieval/fts.ts` (D3-08/D3-09, STOR-01). It used
 * to live outside `src/lib/storage/`, which meant `SqliteStorageDriver` (`./sqlite.ts`) imported a
 * helper from `src/lib/retrieval/` — a driver depending on retrieval code was the mechanical half
 * of the STOR-01 violation. `SqliteStorageDriver` is the only caller; this file has no other
 * reason to exist.
 */

/** FTS5 operator/punctuation characters that turn a natural-language question into a MATCH
 * syntax error if passed through unescaped (quotes, `*`, `NEAR`, parens, colon, caret, `+`/`-` as
 * unary operators, and common sentence punctuation). Every remaining token is then re-wrapped in
 * its own double quotes and joined with `OR`, so FTS5 treats each as a literal term rather than
 * re-parsing any residual special meaning, and a question that only shares a few words with a
 * chunk still surfaces it (an implicit `AND` across every token in the question would routinely
 * match nothing).
 */
export function sanitizeFtsQuery(query: string): string {
  const stripped = query
    .replace(/["*^():+~-]/g, " ")
    .replace(/\bNEAR\b/gi, " ")
    .replace(/[?!.,;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = stripped.split(" ").filter((t) => t.length > 0);
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
