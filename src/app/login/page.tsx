"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation.js";

interface LoginErrorBody {
  code: string;
  message: string;
  action: string;
}

/**
 * Minimal admin sign-in form. POSTs to `/api/auth/login` and renders the returned
 * `{ code, message, action }` inline on failure — including the 429 rate-limit case, which shows
 * a retry-after wait rather than looking like an ordinary wrong password. On success, navigates
 * to the `next` query param (set by `src/proxy.ts`'s redirect) or `/documents`.
 */
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<LoginErrorBody | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);
  const [networkErrorMessage, setNetworkErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setLoginError(null);
    setRetryAfterSeconds(null);
    setNetworkErrorMessage(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        const next = searchParams.get("next") ?? "/documents";
        router.push(next);
        return;
      }

      const body = (await response.json()) as LoginErrorBody;
      setLoginError(body);
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("Retry-After");
        setRetryAfterSeconds(retryAfterHeader ? Number(retryAfterHeader) : null);
      }
    } catch {
      setNetworkErrorMessage("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <h1>Sign in</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="admin-password">Admin password</label>
        <input
          id="admin-password"
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
          required
        />
        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {loginError ? (
        <p role="alert" data-error-code={loginError.code}>
          <strong>{loginError.code}</strong>: {loginError.message}
          {retryAfterSeconds !== null ? ` Try again in ${retryAfterSeconds} seconds.` : ""}{" "}
          {loginError.action}
        </p>
      ) : null}

      {networkErrorMessage ? <p role="alert">{networkErrorMessage}</p> : null}
    </main>
  );
}

/** `useSearchParams` requires a Suspense boundary in the App Router or the page bails out of
 * static rendering with a build error — the form itself has no fallback UI worth showing since
 * it renders near-instantly. */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
