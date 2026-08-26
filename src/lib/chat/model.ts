/**
 * D2-09c/D2-09d — the single provider factory. This is the ONLY file in the product that knows
 * which chat provider is in play; nothing downstream (route, groundedness, condense) branches on
 * a key. Embeddings do NOT come through here — per D2-09a's reasoning (unchanged by D2-09c), they
 * stay on the direct `@google/genai` client because OpenRouter's forwarding of Google's `taskType`
 * is unverified and a dropped `taskType` degrades retrieval with no error raised.
 *
 * The product ships working on `GEMINI_API_KEY` alone — one key, one account. If
 * `OPENROUTER_API_KEY` is present and non-blank in the environment, chat routes through
 * OpenRouter instead; a buyer who has never heard of OpenRouter must never encounter the concept
 * (no startup check, no health-check row, no "consider setting OPENROUTER_API_KEY" hint anywhere
 * in this file or any caller).
 *
 * Resolution happens at CALL time, not at module import time — a module-level constant would
 * freeze the provider choice at first import and break both runtime reconfiguration and the tests
 * that mutate `process.env` between calls in a single process.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { PRODUCT_CONFIG } from "../config.js";
import { AppError } from "../errors.js";

export type ChatProvider = "google" | "openrouter";

/** Empty string and whitespace both count as "absent" — a buyer who copied `.env.example` and
 * left the line blank must land on the default Google path, never a provider call with a blank
 * key. */
function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Returns `"openrouter"` if and only if `OPENROUTER_API_KEY` is present and non-blank; otherwise
 * `"google"`. Presence-only — never inspects, logs, or validates the key's value here (T-02-07-07:
 * provider selection must not leak key presence via a side channel).
 */
export function resolveChatProvider(): ChatProvider {
  return isPresent(process.env.OPENROUTER_API_KEY) ? "openrouter" : "google";
}

function buildGoogleModel(modelId: string): LanguageModel {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!isPresent(apiKey)) {
    // Never KDL-CFG-004 here — a buyer on the default path has no reason to have heard of
    // OpenRouter, and the missing key is GEMINI_API_KEY regardless of which branch is active.
    throw new AppError("KDL-CFG-001");
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return google(modelId);
}

function buildOpenRouterModel(modelId: string): LanguageModel {
  const apiKey = process.env.OPENROUTER_API_KEY;
  // resolveChatProvider() only returns "openrouter" when this key is present and non-blank, so
  // this branch is only ever reached with a key already known to be present.
  const openrouter = createOpenRouter({ apiKey: apiKey as string });
  return openrouter.chat(modelId);
}

function buildModel(kind: "model" | "judgeModel"): LanguageModel {
  const provider = resolveChatProvider();
  if (provider === "google") {
    const modelId =
      kind === "model" ? PRODUCT_CONFIG.chat.google.model : PRODUCT_CONFIG.chat.google.judgeModel;
    return buildGoogleModel(modelId);
  }
  const modelId =
    kind === "model" ? PRODUCT_CONFIG.chat.openrouter.model : PRODUCT_CONFIG.chat.openrouter.judgeModel;
  return buildOpenRouterModel(modelId);
}

/** The model every answer-generation call uses. Construct fresh per call — never cache the
 * returned model across requests, since the active provider can change between calls (see the
 * call-time resolution note above). */
export function chatModel(): LanguageModel {
  return buildModel("model");
}

/** The model `checkGroundedness`/`condenseQuery` use for their structured judge calls. Deliberately
 * independent of `chatModel()`'s call site so a cheaper/faster model can be swapped in for
 * judgement without touching the answer-generation path. */
export function judgeModel(): LanguageModel {
  return buildModel("judgeModel");
}
