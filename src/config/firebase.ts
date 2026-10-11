// Hardcoded Firebase Realtime Database credentials (no .env file used).
// All messenger sessions persist under the `shipu-messsenger-bot` node so
// existing data elsewhere in the database is never touched.
export const firebaseConfig = {
  apiKey: "AIzaSyBIuJFn74hJK1LT_Shcl-Y5DMgiOArB8Ps",
  authDomain: "shipu-ai.firebaseapp.com",
  databaseURL: "https://shipu-ai-default-rtdb.firebaseio.com",
  projectId: "shipu-ai",
  storageBucket: "shipu-ai.firebasestorage.app",
  messagingSenderId: "953122849300",
  appId: "1:953122849300:web:f821f1a161ce7879001d01",
  measurementId: "G-N2WMSS3MNG"
};

/** Root node for every record owned by this bot. Nothing is read/written outside it. */
export const FIREBASE_BOT_ROOT = "shipu-messsenger-bot";
