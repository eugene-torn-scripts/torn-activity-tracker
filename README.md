# Torn Activity Tracker

A faction activity intelligence tool for [Torn City](https://www.torn.com). Tracks when faction members are online so you can see at a glance **when your opponents are most active** — and pick the right moment to push or turtle in ranked wars.

The system is a **userscript + backend** combo. The userscript provides the in-Torn UI; the backend continuously polls the Torn API on behalf of registered users to build up an activity history that no single browser session could collect alone.

---

## Why this exists

Torn's API exposes each player's `last_action` timestamp/status on demand, but it does **not** expose any historical activity data. To know "10 enemies were online Monday at 20:00 last week" you have to *collect that data yourself, over time*. This tool does the collection in the background and visualises it as comparison tables/heatmaps when a war is detected.

---

## How it works

1. **User registers** by pasting their Torn **public** API key into the userscript.
2. **Backend stores the key** (encrypted at rest) and uses it — at a polite **20 calls/minute** out of the 100 Torn allows — to poll faction member endpoints.
3. **Polling targets** are calculated per user:
   - The user's own faction
   - All factions in the same ±1 division (matchmaking range)
   - Within the matchmaking faction-size window:
     - max members = `round((my_members + 5) × 1.25)`
     - min members = `round((my_members ÷ 1.25) − 5)`
   - Up to 5 manually-added factions (watchlist override)
4. **Cross-key coordination**: when multiple users have overlapping target sets, only **one** of their keys actually polls each faction per cycle (no wasted calls). Spare budget on any key is used to poll factions outside the user's own scope, growing the global dataset.
5. **Snapshot interval**: every 30 minutes. Each snapshot records each member's `last_action.status` and `timestamp`, aggregated into per-user-per-hour activity buckets.
6. **Opponent detection**: backend polls each registered user's `/faction/{id}/wars` every 5 minutes. When a ranked war is detected, the opponent faction is promoted to high-priority polling and the userscript starts displaying comparison data.
7. **Retention**: 30 days. A nightly job purges activity older than that, plus assorted redundant data (orphaned snapshots, departed members, ended wars, etc.).

---

## Features

### Userscript UI

A footer button injected next to Torn's Notes/People panel buttons opens a modal with these tabs:

| Tab | Content |
|---|---|
| **Hour Grid** | Color-coded heatmap: date rows × 24 hour columns, showing % of members online each hour. Faction selector (own + watchlist), configurable date range (3/7/14/30 days). Optional **Include idle** toggle switches the metric from `online / total` to `(online + idle) / total`. All times TCT (UTC). |
| **Weekday Avg** | Bar chart of average % online per hour-of-day (0–23), aggregated across the selected date range. Spot recurring activity patterns at a glance. Optional **Include idle** toggle switches the metric from online-only to online+idle (requires the backend to expose `avg_pct_online_or_idle` — a clear inline warning is shown on older deployments). |
| **Compare** | Side-by-side faction comparison. Sortable member tables with hours online, % online, and estimated battle stats (via FFScouter). Synchronized scrolling. Click a member from each side to see per-user activity heatmaps. War opponents auto-appear in dropdown. |
| **Settings** | User badge · Watchlist management (candidate picker + manual faction ID, max 5 manual; war opponents auto-managed) · FFScouter API key integration · Account removal. |
| **Admin** | System dashboard (admin-only): registered users, faction DB stats by division, poll job overview, API call log, server load (CPU/RAM/uptime). |

All data tabs include an **Export CSV** button to download the displayed data.

On a fresh registration the panel shows "No activity data yet — check back soon" until the first 30-min poll cycle completes.

### Backend

- REST API for the userscript (auth, watchlist, activity queries, admin)
- Admin endpoints (system stats, poll jobs, users, API calls) restricted by `ADMIN_USER_ID` env var
- Job scheduler with `poll_jobs` queue + optimistic claim pattern for cross-key dedup
- Opportunistic cold polling: unused API budget fills global dataset for non-candidate factions (1-hour cadence)
- Snapshot worker: 1-min tick claims due jobs, polls `/faction/{id}/members`, upserts `activity_snapshots` per member per hour bucket
- Torn API client with per-key in-memory rate-limit accounting (20/min soft cap)
- War detection: polls `/faction/{id}/wars` every 5 min, promotes opponents to hot priority, auto-adds to watchlist (auto-removed when war ends)
- Daily faction enumeration sweep (03:00 UTC — discovers factions, marks destroyed, refreshes stale basic info)
- Nightly cleanup (04:00 UTC — purges snapshots >30d, call log >7d, stale members, ended wars, orphan jobs)
- Auto-disable of invalid API keys (Torn error code 2 → userscript gets 401 on next call)
- Health endpoint (`GET /health`)
- API call audit log (`api_call_log` table, 7-day retention)

---

## Activity definition

A member's status at each 30-min snapshot maps to that hour's bucket:

| `last_action.status` | Bucket effect |
|---|---|
| `Online` | +30 min `active_minutes` |
| `Idle` AND `last_action.timestamp` within last 30 min | +30 min `idle_minutes` |
| Anything else | (no contribution) |

If two snapshots fall within the same UTC hour, the **max** of each metric is taken (no double-counting). A user is "active" in hour H if `active_minutes > 0`, "idle" if `idle_minutes > 0` AND `active_minutes == 0`.

---

## Architecture

```
┌──────────────────────────┐         ┌──────────────────────────┐
│  Userscript (Tampermonkey)│  HTTPS  │  Backend (Oracle Free)   │
│  ─────────────────────────│ ◄─────► │  ─────────────────────── │
│  Footer button + modal   │ Bearer  │  Fastify (Node.js)       │
│  Auth screen on first run│ <key>   │  Job scheduler           │
│  Reads from BE only      │         │  Torn API client (20/min)│
└──────────────────────────┘         │  Oracle Autonomous DB    │
                                     └────────────┬─────────────┘
                                                  │ 100/min per key
                                                  ▼
                                         ┌──────────────────┐
                                         │ Torn API v2      │
                                         └──────────────────┘
```

**Stack**:
- Backend: Node.js + Fastify
- Database: Oracle Autonomous Database (Always Free tier, 20 GB)
- Hosting: Oracle Cloud Always Free — VM.Standard.E2.1.Micro (1/8 OCPU burstable to 1, 1 GB RAM, AMD EPYC x86_64)
- TLS: Let's Encrypt via DuckDNS subdomain
- Userscript manager: Tampermonkey (Violentmonkey/Greasemonkey should also work)

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full details.

---

## Authentication

- The user pastes their **public** Torn API key into the userscript on first run.
- The userscript stores the key locally (`GM_setValue`) and sends it as `Authorization: Bearer <key>` on every backend request.
- The backend stores an encrypted copy (AES-256-GCM) and uses it to call Torn on the user's behalf.
- No additional tokens, no rotation flow — the API key itself is the credential.

See [`docs/AUTH.md`](docs/AUTH.md) for full security model.

---

## Privacy & disclaimer

The auth screen shows this short-form notice always-visible, with a "Read full disclaimer" link to a popup containing the long form:

> **Your Torn public API key is encrypted at rest on our server and used only to fetch faction activity data on your behalf, capped at 20 calls/minute (Torn allows 100). It is never shared, exported, or used for anything else. You can remove it instantly via Settings.**

**What's stored:**
- Encrypted public API key
- Your Torn user ID, name, and current faction
- Your manual watchlist (up to 5 faction IDs)

**What's collected globally** (about all observed players):
- `(user_id, hour, active_minutes, idle_minutes)` rows for any player whose faction has been polled

**On API key removal:**
- Your `users` row, encrypted key, and bearer token are purged immediately
- Anonymized observations (activity rows about other players) are retained because they're part of the shared dataset that benefits other users
- Any Torn user can request deletion of activity rows about themselves via [contact channel TBD]

**Compliance**:
- HTTPS-only
- API key never logged, never returned to the client after submission
- Polling rate well below Torn's published limit
- See `docs/AUTH.md` for the security model

---

## Repository layout

```
torn-activity-tracker/
├── README.md                 ← this file
├── backend/
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── server.js         ← Fastify entrypoint, route registration, graceful shutdown
│       ├── config.js         ← env parsing + production validation
│       ├── crypto.js          ← AES-256-GCM encrypt/decrypt + SHA-256 fingerprint
│       ├── db/
│       │   └── pool.js       ← Oracle connection pool (thin mode)
│       ├── middleware/
│       │   └── auth.js       ← Bearer → fingerprint → user lookup decorator
│       ├── routes/
│       │   ├── auth.js       ← POST /register, DELETE /me
│       │   ├── watchlist.js  ← GET/POST/DELETE watchlist CRUD + GET /candidates
│       │   ├── activity.js   ← GET /hourly, GET /summary, GET /members, GET /factions, GET /user-hourly
│       │   └── admin.js      ← GET /stats, GET /jobs, GET /users, GET /calls (admin-only)
│       ├── scheduler/
│       │   ├── index.js      ← timer orchestration (snapshot tick, war poll, daily enum)
│       │   ├── snapshots.js  ← claim jobs → poll members → upsert activity
│       │   ├── wars.js       ← war detection → upsert wars → promote opponents
│       │   ├── candidates.js ← ±1 division + size range + watchlist + wars
│       │   ├── jobs.js       ← poll_jobs CRUD (ensure, claim, complete, downgrade)
│       │   └── enumerate.js  ← daily faction search + basic refresh
│       └── torn-client/
│           └── index.js      ← Torn API v2 wrapper (user, faction, wars, search)
├── schema/
│   └── init.sql              ← Oracle DDL (8 tables, indices)
├── userscript/
│   └── torn-activity-tracker.user.js  ← v0.8 — auth, heatmap, compare, admin, FFScouter BS, CSV export
└── docs/
    ├── ARCHITECTURE.md
    ├── AUTH.md
    └── SETUP.md
```

---

## Roadmap

Phased delivery — each phase ends with something demonstrable.

- [x] **v0.1** — BE skeleton: Fastify + Oracle DB + auth routes (register/delete) + AES-256 encryption + Torn API client.
- [x] **v0.2** — Watchlist endpoints, candidate set computation (±1 division + size range), poll_jobs management, daily faction enumeration scheduler.
- [x] **v0.3** — War detection via `/faction/{id}/wars` poller (every 5 min) + war-state table + opponent promotion to hot priority.
- [x] **v0.4** — Userscript v0.4: auth screen with disclaimer, modal panel, 4 tab skeleton, settings tab with watchlist CRUD + account removal.
- [x] **v0.5** — Snapshot worker (1-min tick, job claim, member polling, activity upsert) + activity API endpoints + hour grid heatmap + weekday avg bar chart + CSV export. **First end-to-end demo.**
- [x] **v0.6** — Per-user breakdown tab with member table, activity bars, CSV export.
- [x] **v0.7** — Nightly cleanup (04:00 UTC — 30-day snapshots, 7-day call log, stale members/wars/jobs). HTTP rate limiting (60 req/min per user). Idle classification fix (checks last_action timestamp). Opportunistic cold polling for non-candidate factions.
- [x] **v0.8** — Compare tab (side-by-side faction member tables, sortable, synced scroll, per-user heatmap on click). FFScouter battle stats integration. War opponents auto-added to watchlist. Candidate picker for watchlist. Admin tab with server load. Faction validation on manual watchlist add.

---

## Operational limits & scale

- **Per-key API budget**: 20 calls/min × 60 × 24 = **28,800/day** (Torn allows 144,000/day; we use ~20%).
- **Single-user scope**: ~50–300 candidate factions × 48 polls/day = ~2,400–14,400 calls/day → fits comfortably in one key.
- **Multi-user**: cross-key dedup means N users with overlapping watchlists make far fewer than N × 14,400 calls.
- **Storage**: ~10 bytes per `activity_snapshots` row × ~5,000 active factions × ~80 members × 720 hours/month ≈ 3 GB peak (well under the 20 GB Oracle free tier).
- **Compute**: Fastify on 1/8 OCPU is modest but workable — the Node process sits around 40–80 MB RAM and near-zero CPU at steady state; the E2.1.Micro bursts to 1 full OCPU under load.

---

## License

TBD. Personal/private project for now.
