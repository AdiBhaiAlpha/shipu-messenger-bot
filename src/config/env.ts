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
  setDefault('OPENROUTER_API_KEY', 'cohere_nNS6cpJnJiYYKW8wUkUjWClGx6MzyLRW8pT6nuSx3szSg2');
  setDefault('GEMINI_API_KEY', 'AQ.Ab8RN6L1bIzRMYMLjgJO2uvIMLUusGOeI9I3_4xHisAUMHha2w');
  setDefault('GOOGLE_API_KEY', 'AQ.Ab8RN6L1bIzRMYMLjgJO2uvIMLUusGOeI9I3_4xHisAUMHha2w');
  setDefault('AI_MODEL', 'gemma-4-26b-a4b-it');

  // Session limits
  setDefault('MAX_AUTHORIZED_ACCOUNTS', '10');
  setDefault('MAX_COOKIE_SESSIONS', '5');
  setDefault('FCA_LOGIN_TIMEOUT_MS', '90000');

  // Client portal API key (empty = allow plug-and-play client requests)
  setDefault('SHIPU_CLIENT_API_KEY', '');
}
