// Vercel serverless entry (ESM): serves the prebuilt Express app
// (dist/server.cjs, produced by `npm run build`).
const bundled = await import('../dist/server.cjs');
const { app, startServer } = bundled.default ?? bundled;

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

export default async function handler(req, res) {
  try {
    await ensureBooted();
  } catch (err) {
    res.status(500).json({ success: false, error: `Engine boot failed: ${(err && err.message) || err}` });
    return;
  }
  app(req, res);
}
