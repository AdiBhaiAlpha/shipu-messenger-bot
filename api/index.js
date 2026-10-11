// Vercel serverless entry: serves the prebuilt Express app (dist/server.cjs,
// produced by `npm run build`). Plain CommonJS on purpose — Vercel's bundler
// cannot resolve the extensionless TS imports used across src/.
const { app, startServer } = require('../dist/server.cjs');

let boot = null;

function ensureBooted() {
  if (!boot) {
    // http:false -> skip app.listen(); Vercel serves `app` via this handler.
    boot = startServer({ http: false }).catch((err) => {
      console.error('[VERCEL] Engine boot failed:', (err && err.message) || err);
      boot = null;
      throw err;
    });
  }
  return boot;
}

module.exports = async function handler(req, res) {
  try {
    await ensureBooted();
  } catch (err) {
    res.status(500).json({ success: false, error: `Engine boot failed: ${(err && err.message) || err}` });
    return;
  }
  app(req, res);
};
