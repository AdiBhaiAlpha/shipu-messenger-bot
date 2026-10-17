// Hardcoded AI provider keys (no .env file used).
// Order matters: PRIMARY is tried first, FALLBACK only when the primary is
// rejected (401/403), rate-limited (429), or unreachable.
// Cohere trial key is PRIMARY (user-supplied, higher priority).
// OpenRouter keys follow as fallbacks.
export const COHERE_API_KEY =
  "cohere_nNS6cpJnJiYYKW8wUkUjWClGx6MzyLRW8pT6nuSx3szSg2";

export const OPENROUTER_PRIMARY_KEY =
  "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";

export const OPENROUTER_FALLBACK_KEY =
  "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";

/** Ordered list of all API keys to try. First entry = primary. */
export const AI_API_KEYS: string[] = [
  COHERE_API_KEY,
  OPENROUTER_PRIMARY_KEY,
  OPENROUTER_FALLBACK_KEY,
];

/** Ordered list of OpenRouter keys to try. First entry = primary. */
export const OPENROUTER_KEYS: string[] = [
  OPENROUTER_PRIMARY_KEY,
  OPENROUTER_FALLBACK_KEY,
];
