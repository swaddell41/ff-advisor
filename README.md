# Dynasty Fantasy Football Assistant

A personal-use tool that ingests Sleeper dynasty league data, grades historical trades, and profiles manager trading tendencies. Built to give you an analytical edge in dynasty leagues.

Inspired by [rosteraudit.com](https://rosteraudit.com) — but you control the data, values, and analysis.

---

## ⭐ Draft Assistant (Chrome extension) — start here

The most active part of this repo: a Chrome MV3 extension that turns
**Sleeper and ESPN draft rooms** into an advised draft board. It injects
live value badges into the site's own player list, keeps a roster-aware
pick bar on screen (with cost-of-waiting and positional-run warnings),
and explains every recommendation in a tabbed audit panel.

No build step — install takes two minutes:
**[extension/README.md](extension/README.md)** has the install steps and
a full write-up of how the recommendation engine works.

---

## Requirements

- Python 3.11+ (managed via pyenv recommended)
- Node 18+ (managed via nvm recommended)
- A Sleeper account and your league IDs

---

## Setup

### 1. Clone and configure environment

```bash
cp .env.example .env
# Edit .env — fill in SLEEPER_USER_ID and LEAGUE_IDS
```

### 2. Install all dependencies

```bash
make setup
```

This runs `pip install -e ".[dev]"` in `backend/` and `npm install` in `frontend/`.

### 3. Ingest your leagues

```bash
make ingest
```

Walks the `previous_league_id` chain from each league in `LEAGUE_IDS`, pulling all seasons of transactions, rosters, drafts, and traded picks into `data/dynasty.db`. Safe to re-run — all writes are idempotent.

### 4. Snapshot current player values

```bash
make snapshot
```

Pulls current dynasty values from RosterAudit and stores them in `data/dynasty.db`. Run this weekly to build a value history. The first run is required before grading works.

### 5. Run the app

```bash
# Terminal 1 — backend (FastAPI, port 8000)
make backend

# Terminal 2 — frontend (Vite dev server, port 5173)
make frontend
```

Open [http://localhost:5173](http://localhost:5173).

---

## Project Structure

```
backend/
  app/
    main.py           — FastAPI app
    db.py             — SQLite connection + schema
    ingestion/        — Sleeper + RosterAudit API clients
    grading/          — Trade evaluation logic (Phase 2)
    profiles/         — Manager profile aggregations (Phase 3)
    api/              — FastAPI route handlers
  scripts/
    ingest_leagues.py — Manual ingestion entry point
    snapshot_values.py — Weekly value snapshot
  tests/              — pytest tests
frontend/
  src/                — React + TypeScript (Vite)
data/
  dynasty.db          — SQLite database (gitignored)
```

---

## Scripts

| Command          | Description                                      |
|------------------|--------------------------------------------------|
| `make setup`     | Install Python + Node dependencies               |
| `make ingest`    | Run full Sleeper ingestion pipeline              |
| `make snapshot`  | Snapshot current RosterAudit values              |
| `make backend`   | Start FastAPI dev server (port 8000)             |
| `make frontend`  | Start Vite dev server (port 5173)                |
| `make test`      | Run pytest test suite                            |

---

## Value Attribution

Player values powered by [RosterAudit.com](https://rosteraudit.com).

---

## Phases

- **Phase 1** (complete): Data ingestion and storage
- **Phase 2**: Trade grading engine + history UI
- **Phase 3**: Manager profiles + LLM scouting reports
- **Phase 4** (deferred): Cross-league profiling, roster gap analysis, trade proposer
