# Shipu Messenger Bot — Production-Ready Messenger Group Chat Bot Platform

A modular, event-driven, extensible Facebook Messenger group chat bot platform with a real-time admin dashboard, built with **Node.js**, **TypeScript**, **Express**, **React**, **Tailwind CSS**, and **Firebase Realtime Database**. AI replies are powered by **OpenRouter** (16 free models with automatic fallback) plus an internal knowledge graph (brain, memory, behaviour profiles).

> Built and maintained by **Chitron Bhattacharjee Adi** — **ORCHID Lab**.

---

## 🌟 Key Features

- **🤖 Central Bot Core**: Event-driven message dispatcher with prefix resolution, alias mapping, role permission verification, and cooldown limiters.
- **🔌 Plugin Command System**: Modular, self-contained plugins loaded dynamically without modifying the core engine (`onStart`, `onReply`, `onReaction`, `onChat`, `onEvent`).
- **💬 Reply & Reaction Routers**: State-aware reply queue routing nested conversational replies and emoji reaction triggers directly back to command instances.
- **🛡️ Messenger Adapter Layer**: Abstracted `MessengerAdapter` interface isolating Messenger API / FCA logic from commands, with `MockMessengerAdapter` for live browser simulation.
- **👥 Group Thread Management**: Per-group prefix (`#`), language (`bn`/`en`), timezone (`Asia/Dhaka`), welcome/goodbye greetings, anti-spam, and anti-link filters.
- **💰 Economy & Game Engine**: Atomic cash and bank transactions, daily rewards, mini-jobs, peer transfers, leaderboards, and Rock-Paper-Scissors betting games.
- **🧠 OpenRouter AI (free models)**: 16 free OpenRouter models tried in order with automatic fallback, circuit breaker, and a sticky "last working model" that is remembered across restarts.
- **🧬 Self-Learning Shipu**: Shipu is a human persona (never admits being an AI). Learns from every message — tone, emoji usage, Bangla typing style, word pairs — and evolves nightly via self-reflection (free model only).
- **💬 Auto-Reply Engine**: No trigger needed. Shipu decides when to reply (intent dedup, cooldown, DM always-reply, command priority) and initiates conversation after 30 min of silence.
- **💡 Emotion State Machine**: Per-user mood tracking + reply tone shift + personality evolution over time.
- **💻 Admin Dashboard**: Real-time control panel with live Messenger simulator, thread manager, user/role editor, custom plugin code builder, and searchable terminal log viewer.
- **🔥 Firebase RTDB**: All data (users, threads, commands, sessions, brain, behaviour profiles) lives under `shipu-messsenger-bot` in Firebase Realtime Database.

---

## 📁 Folder Structure

```text
shipu-messenger-bot/
├── api/               # Vercel serverless entry
├── commands/          # Plugin Commands (System, Admin, Economy, Fun, AI)
├── src/
│   ├── core/          # Central Engine, Dispatcher, Plugin Loader
│   ├── commands/      # Extra command files
│   ├── services/      # AI, Brain, Self-Learning, Emotion, Scheduler
│   ├── db/            # Firebase RTDB data layer (firebaseDb.ts)
│   ├── adapters/      # MessengerAdapter Interface & FCA providers
│   ├── utils/         # Helper functions & Formatters
│   └── components/    # React admin dashboard
├── server.ts          # Express server + API routes
├── start.cjs          # Production bootstrap
├── render.yaml        # Render deployment config
└── vercel.json        # Vercel deployment config
```

---

## 🚀 Quick Start

```bash
npm install
npm run dev          # development (tsx server.ts)
npm run build        # vite build + esbuild server.cjs
npm start            # production (node start.cjs)
```

Health check: `GET /api/health` · Deep probe: `GET /api/health/deep`

---

## 🔑 Configuration

All credentials are **hardcoded** (no `.env` file is used):

- **Firebase RTDB**: `shipu-ai-default-rtdb.firebaseio.com`, root node `shipu-messsenger-bot`
- **OpenRouter**: primary + fallback keys in `src/config/aiKeys.ts` (16 free models in `src/config/aiModels.ts`)
- **Admin**: `admin` / `shipu_secret_password_2026`
- **FTP**: `ftpupload.net` (hardcoded in `src/db/database.ts`)

Session cookies are stored encrypted in Firebase and restored on every boot, so server restarts never lose sessions.

---

## 🧠 AI Architecture

- **Provider**: OpenRouter (free models only) + Google AI Studio fallback
- **Model chain**: 16 free models tried in order; the last successful model becomes the sticky default until it errors
- **Circuit breaker**: 3 consecutive failures → 10-min cooldown per model
- **Knowledge**: Brain DB (trigger/reply pairs), AIOSMemory (per-user facts), behaviour profiles (tone/emoji/style), conversation context (40 turns)
- **Self-learning**: passive fact extraction, nightly reflection (03:00 cron), conflict resolution, knowledge ingestion from files/web
- **Persona**: Shipu — a real human. Never admits being an AI. Uses internal knowledge silently.

---

## 📡 Deployment

- **Render** (recommended for bot runtime): `render.yaml` provided, always-on process keeps MQTT stable
- **Vercel** (dashboard/API): `vercel.json` provided, serverless function serves the prebuilt bundle

---

## 📜 License

Original work by **Chitron Bhattacharjee Adi** — **ORCHID Lab**. All rights reserved.
EOF
echo "README written"