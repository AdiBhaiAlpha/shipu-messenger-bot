// Hardcoded runtime configuration. No .env file is used in this project:
// every credential below is intentionally inlined so a server restart always
// boots with the same values.
export const databaseConfig = {
  type: "firebase-rtdb",
  autoSyncWhenStart: true,
  autoRefreshThreadInfoFirstTime: true
};

export const initialAdminBot = [
  "100081330372098",
  "61579127085437"
];
