/**
 * WIDG-05 origin allowlisting. **D3-12: the `Origin` header is spoofable by any non-browser
 * client** — curl, a server-side script, or any HTTP client that isn't a real browser can set
 * whatever `Origin` value it likes. This module is therefore a CONVENIENCE FILTER that stops
 * accidental embedding and misconfiguration (a buyer's own site pasted into the wrong domain, a
 * stray `<iframe>` from an unrelated page), NOT an authentication or authorization boundary. The
 * rate limiter (`src/lib/rate-limit/`) is the control that actually protects the buyer's Gemini/
 * OpenRouter costs. Do not let a future reader mistake exact-host matching here for real security
 * — it stops honest mistakes, not a determined attacker.
 */

/** Takes what a buyer typed into the "Allowed domains" field and returns a bare, lowercase host —
 * e.g. `example.com` — or `null` if the input cannot be interpreted as a bare domain. Deliberately
 * rejects a full URL rather than helpfully parsing it (UI-SPEC's validation copy: "Enter a domain,
 * like example.com — not a full URL."): a scheme is stripped only when nothing else remains after
 * it but a bare host, a query string is dropped, but any path segment (a `/` remaining after
 * stripping) means the input was a URL, not a domain, and is rejected. */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return null;
  }

  let host = trimmed.toLowerCase();

  // Strip a leading scheme (buyer pasted "https://example.com" instead of "example.com").
  host = host.replace(/^https?:\/\//, "");

  // Drop a query string entirely — "example.com?x=1" is still just a domain with noise attached.
  const queryIndex = host.indexOf("?");
  if (queryIndex !== -1) {
    host = host.slice(0, queryIndex);
  }

  // Strip a single trailing slash ("example.com/" -> "example.com").
  host = host.replace(/\/+$/, "");

  // Strip a trailing dot ("example.com." -> "example.com" — a valid, if unusual, FQDN form).
  host = host.replace(/\.$/, "");

  // Strip a leading "www." so a buyer who types either form gets the same stored value.
  host = host.replace(/^www\./, "");

  // Anything left containing a slash means a path survived stripping — this was a full URL, not
  // a bare domain, and must be rejected rather than partially parsed.
  if (host.includes("/")) {
    return null;
  }

  // A port (":") is not a bare host either.
  if (host.includes(":")) {
    return null;
  }

  if (host.length === 0) {
    return null;
  }

  return host;
}

/** Checks whether `origin` (an HTTP `Origin` header value) matches one of `allowedDomains` by
 * EXACT host equality — never substring, never `endsWith`, never a wildcard. `www.` is stripped
 * from the incoming origin's host before comparison, so a buyer who lists `example.com` is also
 * matched by a request whose origin is `https://www.example.com`. An empty allowlist allows
 * nothing (UI-SPEC's empty-state copy warns the buyer about exactly this, so silently allowing
 * everything here would contradict what the buyer was shown). Lookalike hosts —
 * `evil-example.com`, `example.com.attacker.net` — are always rejected against an allowlist
 * containing only `example.com`, because exact string equality cannot match either. */
export function isOriginAllowed(origin: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) {
    return false;
  }

  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  const strippedHost = host.replace(/^www\./, "");
  return allowedDomains.some((domain) => domain.toLowerCase() === strippedHost);
}
