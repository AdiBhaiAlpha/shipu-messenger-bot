// Hardcoded OpenRouter free-model catalog (no .env file used).
// Order = fallback priority: model #1 is tried first, then #2 on error, and
// so on. The last successfully responding model is remembered
// (aiConfig.lastWorkingModel) and jumps to the front until it errors.

export interface AiCatalogModel {
  value: string;
  label: string;
  context?: string;
}

export const OPENROUTER_FREE_MODELS: AiCatalogModel[] = [
  { value: 'apodex/apodex-1.1-mini:free', label: 'Apodex 1.1 Mini (free)', context: '262k ctx' },
  { value: 'cohere/north-mini-code:free', label: 'Cohere North Mini Code (free)', context: '256k ctx' },
  { value: 'dots-studio/dots-3-note-preview:free', label: 'Dots3-Note Preview (free)', context: '512k ctx' },
  { value: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B (free)', context: '262k ctx' },
  { value: 'google/gemma-4-31b:free', label: 'Gemma 4 31B (free)', context: '262k ctx' },
  { value: 'liquid/lfm-2.5-2.6b:free', label: 'LFM2.5-2.6B (free)', context: '66k ctx' },
  { value: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', label: 'Nemotron 3 Nano Omni (free)', context: '256k ctx' },
  { value: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super (free)', context: '262k ctx' },
  { value: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra (free)', context: '1M ctx' },
  { value: 'nvidia/nemotron-3.5-content-safety:free', label: 'Nemotron 3.5 Content Safety (free)', context: '128k ctx' },
  { value: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning (free)', context: '1M ctx' },
  { value: 'openrouter/free', label: 'Free Models Router', context: '200k ctx' },
  { value: 'poolside/laguna-s-2.1:free', label: 'Laguna S 2.1 (free)', context: '262k ctx' },
  { value: 'poolside/laguna-xs-2.1:free', label: 'Laguna XS 2.1 (free)', context: '262k ctx' },
  { value: 'thinkingmachines/inkling-small:free', label: 'Inkling Small (free)', context: '1M ctx' },
  { value: 'thinkingmachines/inkling:free', label: 'Inkling (free)', context: '1M ctx' },
];

/** Ordered model ids for the fallback chain. */
export const OPENROUTER_FALLBACK_ORDER: string[] = OPENROUTER_FREE_MODELS.map(m => m.value);
