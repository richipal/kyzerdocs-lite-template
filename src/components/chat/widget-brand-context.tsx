"use client";

/**
 * Deviation from plan 03-08 Task 1 (Rule 2 — missing critical functionality): the UI-SPEC's
 * Copywriting Contract requires the widget's empty-conversation state to read "Ask a question" /
 * "Answers are drawn from {brandName}'s documents." (see `StarterQuestions.tsx`), but `ChatPanel`'s
 * own diff is constrained to exactly two new props (`apiPath`, `variant` — see ChatPanel.tsx's
 * header comment) and neither carries branding. A React context sidesteps a third prop: the embed
 * page (`EmbedChat.tsx`) provides `productName` once, at the top of the tree, and
 * `StarterQuestions` (rendered deep inside `ChatPanel`) reads it directly — zero change to
 * `ChatPanel`'s own prop surface. Admin usage never wraps a provider, so
 * `useWidgetBrandName()` returns `null` there and every consumer must treat that as "not the
 * widget" rather than "brand name is empty".
 */

import { createContext, useContext, type ReactNode } from "react";

const WidgetBrandContext = createContext<string | null>(null);

export function WidgetBrandProvider({
  brandName,
  children,
}: {
  brandName: string;
  children: ReactNode;
}) {
  return <WidgetBrandContext.Provider value={brandName}>{children}</WidgetBrandContext.Provider>;
}

/** `null` when not rendered inside a `WidgetBrandProvider` (i.e. the admin surface). */
export function useWidgetBrandName(): string | null {
  return useContext(WidgetBrandContext);
}
