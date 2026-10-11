// Hardcoded environment bootstrap. This project uses NO .env file:
// every value below is inlined so restarts always boot identically.
// initEnv() only fills in values that are not already set, so an explicit
// platform-provided variable (e.g. PORT on Render) still wins.
function setDefault(key: string, value: string): void {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}

export function initEnv(): void {
  // Server
  setDefault('PORT', '3000');
  setDefault('NODE_ENV', 'development');

  // Dashboard admin
  setDefault('ADMIN_USERNAME', 'admin');
  setDefault('ADMIN_PASSWORD', 'shipu_secret_password_2026');

  // Bot identity
  setDefault('BOT_UID', '61594882714220');
  setDefault('BOT_OWNER_ID', '100081330372098');

  // AI providers (primary keys; OpenRouter fallback lives in aiKeys.ts)
  setDefault('OPENROUTER_API_KEY', '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');
  setDefault('GEMINI_API_KEY', '');
  setDefault('GOOGLE_API_KEY', '');
  setDefault('AI_MODEL', 'google/gemma-2-9b-it:free');

  // Session limits
  setDefault('MAX_AUTHORIZED_ACCOUNTS', '10');
  setDefault('MAX_COOKIE_SESSIONS', '5');
  setDefault('FCA_LOGIN_TIMEOUT_MS', '90000');

  // Client portal API key (empty = allow plug-and-play client requests)
  setDefault('SHIPU_CLIENT_API_KEY', '');
}
