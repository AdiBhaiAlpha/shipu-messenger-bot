import { app, startServer } from '../server.js';

let boot: Promise<unknown> | null = null;

function ensureBooted(): Promise<unknown> {
  if (!boot) {
    // http:false -> skip app.listen(); Vercel serves `app` via this handler.
    boot = startServer({ http: false }).catch((err: any) => {
      console.error('[VERCEL] Engine boot failed:', err?.message || err);
      boot = null;
      throw err;
    });
  }
  return boot;
}

export default async function handler(req: any, res: any) {
  try {
    await ensureBooted();
  } catch (err: any) {
    res.status(500).json({ success: false, error: `Engine boot failed: ${err?.message || err}` });
    return;
  }
  (app as any)(req, res);
}
