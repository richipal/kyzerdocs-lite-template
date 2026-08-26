"use client";

/**
 * CHAT-06's empty-state prompts. Fetches `startersPath` once on mount (default
 * `/api/chat/starters`); an empty corpus returns `{ questions: [] }` (route short-circuits before
 * any model call) and this renders an upload prompt linking to `/documents` — UNLESS `variant`
 * is `"widget"`, in which case UI-SPEC's Copywriting Contract requires different copy with no
 * admin link at all (S-6: a visitor has no admin access, and a dead `/documents` link misdiagnoses
 * what they can do).
 *
 * Deviation from plan 03-08 (Rule 2 — missing critical functionality): this file is not in the
 * plan's `files_modified` list, but `ChatPanel`'s own diff is constrained to exactly two new props
 * (`apiPath`, `variant`) and the plan's own action text requires the starters fetch to be
 * parameterized too ("use it as the transport's `api` value and for the starters fetch"). `variant`
 * and `startersPath` here are the minimal, optional additions that make that possible without
 * touching `ChatPanel`'s prop surface further — admin usage passes neither and is unaffected.
 */

import { useEffect, useState } from "react";
import { useWidgetBrandName } from "./widget-brand-context.js";

type LoadState = "loading" | "ready" | "error";

export function StarterQuestions({
  onSelect,
  variant = "admin",
  startersPath = "/api/chat/starters",
}: {
  onSelect: (question: string) => void;
  variant?: "admin" | "widget";
  startersPath?: string;
}) {
  const [questions, setQuestions] = useState<string[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const brandName = useWidgetBrandName();

  useEffect(() => {
    let cancelled = false;
    fetch(startersPath)
      .then((res) => res.json())
      .then((body: unknown) => {
        if (cancelled) return;
        const list =
          typeof body === "object" && body !== null && Array.isArray((body as { questions?: unknown }).questions)
            ? ((body as { questions: unknown[] }).questions.filter((q): q is string => typeof q === "string"))
            : [];
        setQuestions(list);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [startersPath]);

  if (state === "loading") {
    return (
      <p role="status" className="starters-status">
        Loading suggested questions…
      </p>
    );
  }

  if (questions.length === 0) {
    // Widget empty state (KB has zero documents) — UI-SPEC Copywriting Contract. No link: the
    // visitor reading this has no admin access, so a dead `/documents` link misdiagnoses what
    // they can do about it (S-6).
    if (variant === "widget") {
      return (
        <div className="starters-empty">
          <p>This chat isn&apos;t set up with any documents yet. Please check back soon.</p>
        </div>
      );
    }
    return (
      <div className="starters-empty">
        <p>Upload a document to start asking questions.</p>
        <a href="/documents">Go to Documents</a>
      </div>
    );
  }

  // Widget empty state (has documents, no messages yet) — UI-SPEC Copywriting Contract.
  if (variant === "widget") {
    return (
      <div className="widget-intro">
        <p className="widget-intro__heading">Ask a question</p>
        <p className="widget-intro__body">
          Answers are drawn from {brandName ?? "this knowledge base"}&apos;s documents.
        </p>
        <div data-starters="true">
          {questions.map((question) => (
            <button key={question} type="button" onClick={() => onSelect(question)}>
              {question}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="starters-label">Try asking:</p>
      <div data-starters="true">
        {questions.map((question) => (
          <button key={question} type="button" onClick={() => onSelect(question)}>
            {question}
          </button>
        ))}
      </div>
    </div>
  );
}
