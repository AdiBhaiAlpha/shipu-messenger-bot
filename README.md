# Shipu Messenger Bot — Production-Ready Messenger Group Chat Bot Platform

A modular, event-driven, extensible Facebook Messenger group chat bot platform with a real-time admin dashboard. Built with **Node.js**, **TypeScript**, **Express**, **React**, **Tailwind CSS**, and **Firebase Realtime Database**. AI replies are powered by **OpenRouter** (free models only) with automatic multi-model fallback.

> Built and maintained by **Chitron Bhattacharjee Adi** — **ORCHID Lab**.

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Folder Structure](#folder-structure)
4. [Quick Start](#quick-start)
5. [Configuration](#configuration)
6. [Languages & Locales](#languages--locales)
7. [Frameworks & Libraries](#frameworks--libraries)
8. [Database Schema](#database-schema)
9. [Command Development Guide](#command-development-guide)
10. [Deployment (Free Tiers)](#deployment-free-tiers)
11. [API Reference](#api-reference)
12. [Admin Dashboard](#admin-dashboard)
13. [Troubleshooting](#troubleshooting)
14. [License](#license)

---

## Overview

Shipu Messenger Bot is a Facebook Messenger group chat bot with an integrated admin dashboard. It supports:

- Multi-account Messenger sessions (cookie + OAuth)
- Plugin-based command system (drop a `.js` file and it loads)
- Economy, games, AI chat, moderation, thread management
- Real-time admin dashboard (React + Tailwind)
- Firebase Realtime Database as the single data store
- Self-learning AI that improves from conversations
- Deployable on free tiers (Render, Vercel, Firebase)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22+, TypeScript 5.8 |
| Backend | Express 4, tsx (dev), esbuild (prod bundle) |
| Frontend | React 19, Vite 6, Tailwind CSS 4, Lucide icons |
| Database | Firebase Realtime Database (REST) |
| Messenger | @dongdev/fca-unofficial (primary), @xnil6x, @xaviabot (fallback) |
| AI | OpenRouter (free models), Google AI Studio (fallback) |
| FTP | basic-ftp (cPanel backup/sync) |
| Scheduler | node-cron |
| Image | @napi-rs/canvas, jimp |
| Media | yt-search, ytdl-core, axios |

---

## Folder Structure

```
shipu-messenger-bot/
├── api/                    # Vercel serverless entry (index.js)
├── commands/               # Plugin commands (.js, CommonJS)
├── src/
│   ├── adapters/           # Messenger adapter + FCA providers
│   │   └── messenger/
│   │       ├── fca/        # normalizeAppState, fcaConfig, realtime listener
│   │       └── providers/  # DongDev, Xnil, Xavia (all extend BaseFcaProvider)
│   ├── components/         # React dashboard components
│   ├── core/               # Bot engine, command loader, plugins
│   ├── db/                 # firebaseDb.ts (data layer), database.ts (abstraction)
│   ├── services/           # AI, brain, self-learning, emotion, scheduler, FTP
│   ├── utils/              # commandParser, crypto, imageUtils, textFormatter
│   └── config/             # env, database, firebase, aiKeys, aiModels (all hardcoded)
├── server.ts               # Express server + all API routes
├── start.cjs               # Production bootstrap (auto-build if missing)
├── render.yaml             # Render deployment config
├── vercel.json             # Vercel deployment config
├── package.json            # Dependencies & scripts
├── tsconfig.json           # TypeScript config
└── vite.config.ts          # Vite build config
```

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/AdiBhaiAlpha/shipu-messenger-bot.git
cd shipu-messenger-bot

# 2. Install
npm install

# 3. Run (development)
npm run dev          # tsx server.ts on port 3000

# 4. Build (production)
npm run build        # vite build + esbuild server.cjs

# 5. Start (production)
npm start            # node start.cjs
```

Health check: `GET http://localhost:3000/api/health`
Deep probe: `GET http://localhost:3000/api/health/deep`

---

## Configuration

All credentials are **hardcoded** — no `.env` file is used.

| Config | Location | Value |
|---|---|---|
| Firebase RTDB | `src/config/firebase.ts` | `shipu-ai-default-rtdb.firebaseio.com`, root `shipu-messsenger-bot` |
| Database config | `src/config/database.ts` | type: `firebase-rtdb` |
| Environment | `src/config/env.ts` | PORT, NODE_ENV, admin creds, bot UID, AI model |
| OpenRouter keys | `src/config/aiKeys.ts` | primary + fallback keys |
| OpenRouter models | `src/config/aiModels.ts` | 16 free models in fallback order |
| Admin login | `src/config/env.ts` | `admin` / `shipu_secret_password_2026` |
| FTP | `src/db/database.ts` | `ftpupload.net` (hardcoded) |
| fca-config | `fca-config.json` | mqtt enabled, autoUpdate false |

Session cookies are stored encrypted in Firebase and restored on every boot.

---

## Languages & Locales

| Language | Code | Usage |
|---|---|---|
| Bengali (Bangla script) | `bn` | AI replies in Bangla script |
| Banglish (Bengali in Latin) | `bn-lat` | Natural chat style, default |
| English | `en` | English replies |

- **Auto-detect**: `detectLanguage()` in `src/services/emotionEngine.ts` checks Bangla Unicode ratio + common Banglish words
- **Per-user**: language stored in AIOSMemory, updated on every message
- **AI instruction**: `langInstruction()` injects the correct language directive into the system prompt
- **Thread-level**: each thread has `language` field (`bn`/`en`) in `threadsData`

---

## Frameworks & Libraries

### Backend
| Package | Purpose |
|---|---|
| express | HTTP server + REST API |
| tsx | TypeScript execution (dev) |
| esbuild | Production bundle (server.cjs) |
| mongoose | *Removed* (was MongoDB ODM) |
| firebase (REST) | Database (no SDK dependency) |
| @dongdev/fca-unofficial | Facebook Chat API (primary) |
| axios | HTTP client (OpenRouter, media downloads) |
| node-cron | Scheduled jobs (nightly reflection) |
| basic-ftp | FTP sync/backup |
| @napi-rs/canvas | Image generation (ping, monitor dashboard) |
| jimp | Image processing |
| adm-zip | ZIP import for commands |
| crypto (node) | Encryption (auth state, passwords) |

### Frontend
| Package | Purpose |
|---|---|
| react 19 | UI framework |
| vite 6 | Build tool + dev server |
| tailwindcss 4 | Styling |
| lucide-react | Icons |
| recharts | Charts (performance, analytics) |
| motion | Animations |
| @monaco-editor/react | Code editor (custom commands) |

---

## Database Schema

All data lives under `shipu-messsenger-bot/` in Firebase RTDB.

| Node | Purpose |
|---|---|
| `users/{userID}` | User profiles, money, level, role |
| `threads/{threadID}` | Thread settings, prefix, language, members |
| `messenger-accounts/{accountId}` | Messenger session (encrypted auth state) |
| `storedcommands/{name}` | Custom commands (code + metadata) |
| `botsettings/{key}` | Global config, AI config, Supabase config |
| `adminbots/{uid}` | Admin bot UIDs |
| `brainmemories/{id}` | Brain knowledge (trigger/reply pairs) |
| `aiosmemories/{userID}` | Per-user facts, mood, personality, conversation context |
| `aiossessions/{id}` | Active AIOS sessions (30-min/50-msg) |
| `behaviour/{threadID}/{pushId}` | Behaviour signals (tone, emoji, style) |
| `behaviour-profile/{threadID}` | Aggregate style profile per thread |
| `ai-state/{threadID}` | Auto-reply state (intent dedup, cooldown) |
| `emotion/{userID}` | Mood tracking |
| `lang/{userID}` | Language preference |
| `feedback/{entryId}` | Brain entry scores (👍/👎) |
| `fallbackapis/{id}` | Fallback AI API configurations |
| `economytransactions/{id}` | Economy transaction log |
| `auditlogs/{id}` | Admin audit trail |
| `backups/{tag}/{db}/{collection}` | MongoDB migration backups |

---

## Command Development Guide

### Command File Format (CommonJS)

Every command is a `.js` file in `commands/` or `src/commands/`:

```javascript
const axios = require('axios');

module.exports = {
  config: {
    name: "greet",
    aliases: ["hi", "hello"],
    version: "1.0.0",
    role: 0,              // 0 = user, 1 = group admin, 2 = bot admin, 3 = owner
    author: "YourName",
    description: "Greets the user",
    usage: "#greet [name]",
    countDown: 3,         // cooldown in seconds
    enabled: true,
    category: "Fun"
  },

  onStart: async function({ message, args, event, api, usersData, threadsData, currentUser, currentThread }) {
    const name = args.join(' ') || currentUser?.name || 'friend';
    await message.reply(`Hello ${name}! 👋`);
  },

  onChat: async function({ message, event, api }) {
    // Called for every message when no command matched
  },

  onReply: async function({ message, event, Reply, api }) {
    // Called when user replies to bot's message
  },

  onReaction: async function({ message, event, Reaction, api }) {
    // Called on emoji reaction
  }
};
```

### Key Context Properties

| Property | Type | Description |
|---|---|---|
| `message` | object | `{ reply, send, react, kick }` |
| `args` | string[] | Parsed arguments |
| `event` | object | `{ senderID, threadID, messageID, body, accountId }` |
| `api` | object | Messenger API (sendMessage, react, etc.) |
| `usersData` | object | `{ get, set, increment }` |
| `threadsData` | object | `{ get, set }` |
| `currentUser` | object | `{ userID, name, role, money, ... }` |
| `currentThread` | object | `{ threadID, name, prefix, members, ... }` |
| `botUid` | string | Bot's Facebook UID |

### Steps to Create a New Command

1. Create file: `commands/mycommand.js`
2. Export `config` with `name`, `role`, `countDown`, etc.
3. Export `onStart` (required) — called when command is invoked
4. Optionally export `onChat`, `onReply`, `onReaction`, `onEvent`
5. Restart server or use dashboard hot-reload
6. Test: `#mycommand arg1 arg2`

### Commands in Database

Commands can also be stored in Firebase (`storedcommands` node) and hot-reloaded via dashboard. The `install` command lets users install commands from URLs.

---

## Deployment (Free Tiers)

### Render (Recommended for Bot Runtime)

Render provides always-on processes — MQTT stays stable.

```bash
# 1. Push to GitHub
git push origin main

# 2. Render Dashboard → New Web Service → Connect repo
#    Build: npm install && npm run build
#    Start: npm start
#    Health check: /health
#    Env: NODE_ENV=production
```

Or use `render.yaml` (already in repo).

### Vercel (Dashboard/API only)

Vercel is serverless — good for dashboard, but MQTT won't stay alive.

```bash
# 1. Install Vercel CLI
npm i -g vercel

# 2. Deploy
vercel --prod
```

`vercel.json` handles routing to `api/index.js` → `dist/server.cjs`.

### Firebase (Database)

1. Create Firebase project at console.firebase.google.com
2. Enable Realtime Database
3. Set rules: allow read/write under `shipu-messsenger-bot`
4. Update `src/config/firebase.ts` with your credentials

### Important Notes

- **Render free tier**: sleeps after 15 min of inactivity (use UptimeRobot to ping `/health` every 5 min)
- **Vercel free tier**: 10s function timeout (increase to 60s in vercel.json if on Pro)
- **Firebase free tier**: 1GB storage, 10GB/month transfer — enough for thousands of users

---

## API Reference

### Core
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Basic health check |
| GET | `/api/health/deep` | Per-service probe (DB, AI, FTP, Messenger) |
| GET | `/api/database/status` | Database connection status |
| GET | `/api/firebase/status` | Firebase RTDB status |
| POST | `/api/firebase/test` | Test Firebase connection |

### Messenger Accounts
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/messenger/accounts` | List all accounts |
| POST | `/api/messenger/accounts/cookie` | Add cookie account |
| POST | `/api/messenger/accounts/cookie/update` | Update cookie |
| POST | `/api/messenger/accounts/cookie/delete` | Delete account |
| POST | `/api/messenger/accounts/:id/reconnect` | Reconnect account |
| POST | `/api/messenger/accounts/:id/restart` | Restart engine |
| POST | `/api/messenger/accounts/:id/recover` | Supervisor recovery |

### AI
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/ai-config` | Get AI configuration |
| POST | `/api/ai-config/save` | Save AI configuration |
| POST | `/api/ai-config/test` | Test API key |
| POST | `/api/ai-config/rollback` | Rollback to previous key |

### Commands
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/bot/commands` | List all commands |
| POST | `/api/bot/commands/save` | Save command |
| DELETE | `/api/bot/commands/:name` | Delete command |
| POST | `/api/bot/commands/test` | Test command |
| POST | `/api/bot/commands/bulk-action` | Bulk enable/disable/delete |

### FTP
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/ftp/status` | FTP connection status |
| POST | `/api/ftp/test` | Test FTP connection |
| GET | `/api/ftp/sync/status` | Sync engine status |
| POST | `/api/ftp/sync/start` | Start sync |
| POST | `/api/ftp/sync/stop` | Stop sync |

---

## Admin Dashboard

Access at `http://localhost:3000` (or your deployed URL).

| Section | Description |
|---|---|
| Session Manager | Add/manage Messenger accounts, cookies, MQTT status |
| AI Providers | Configure OpenRouter key, default model, test connection |
| Command Manager | View/edit/delete commands, custom code editor |
| Brain Manager | View/edit brain memories, knowledge entries |
| Thread Manager | Per-thread settings (prefix, language, welcome) |
| User Database | View/edit users, roles, economy |
| Economy | Adjust balances, view transactions |
| FTP Manager | Configure FTP, sync files, backups |
| Telegram | Configure Telegram bot |
| System Status | Health, performance, logs |

---

## Troubleshooting

| Issue | Solution |
|---|---|
| `login_blocked` on cookie | Export fresh cookie from logged-in browser; wait 1 hour if repeated |
| MQTT not connecting | Check `fca-config.json` → `mqtt.enabled: true` |
| AI returns offline | Check OpenRouter key in dashboard; test with `/api/ai-config/test` |
| Firebase 401 | Check rules: `shipu-messsenger-bot` must have read/write true |
| Build fails on Render | Ensure `esbuild` is in dependencies (not devDependencies) |
| Vercel function timeout | Increase `maxDuration` in vercel.json (Pro plan) |
| Port already in use | Kill existing process: `pkill -f "tsx server"` |

---

## License

Original work by **Chitron Bhattacharjee Adi** — **ORCHID Lab**. All rights reserved.
