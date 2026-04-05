# Blnk Anomaly Detector

> A real-time transaction anomaly detection layer for [Blnk Finance](https://blnkfinance.com) — the missing risk signal layer for your ledger.

---

## The Problem

Blnk Core is an excellent ledger: it records transactions immutably, enforces double-entry accounting, and exposes a clean API. But it has no opinion about whether a transaction *should* be happening. Once your wallet app or payment product goes live, you need to answer questions like:

- Is this user sending money unusually fast?
- Is this amount suspiciously close to a regulatory reporting threshold?
- Is money going in and immediately back out — a classic layering pattern?

Blnk leaves that layer to you. This project builds it.

---

## What It Does

The Anomaly Detector is a TypeScript/Node.js service that sits alongside a running Blnk Core instance and:

1. **Receives webhook events** from Blnk every time a transaction is applied
2. **Fetches recent transaction history** for the source balance via the Blnk REST API
3. **Scores the transaction** using a rule-based anomaly engine
4. **Writes the risk score back** to the transaction as Blnk metadata (so it's visible in your ledger)
5. **Displays flagged transactions** on a live dashboard

---

## Architecture

```
Blnk Core (Docker)
     │
     │  webhook: POST /webhook/transaction
     ▼
Anomaly Detector Service (Node.js / TypeScript)
     │
     ├── anomaly-engine.ts   ← scoring rules
     ├── blnk-client.ts      ← REST API wrapper (reads history, writes metadata)
     ├── flag-store.ts       ← in-memory store of flagged events
     └── index.ts            ← Express server (webhook + dashboard API)
     │
     ▼
Dashboard (plain HTML/JS)    ← http://localhost:3000
```

The key integration points with Blnk Core:
- `GET /balances/:id/transactions` — fetch history to provide context for scoring
- `PATCH /transactions/:id/metadata` — write risk score back to the ledger
- Webhooks — receive real-time `transaction.applied` events

---

## Detection Rules

Each rule fires independently and contributes a weight to the final risk score (0.0–1.0). A transaction is flagged if it exceeds the configurable threshold (default: `0.6`).

| Rule | Trigger | Weight |
|------|---------|--------|
| `VELOCITY_SPIKE` | More than 5 transactions from the same source within 10 minutes | 0.40 |
| `STRUCTURING` | Amount within 5% below a common reporting threshold (1k, 5k, 10k) | 0.50 |
| `LARGE_TRANSFER` | Single transfer above 50,000 | 0.30 |
| `ROUND_NUMBER` | Suspiciously round amount above 5,000 (e.g. exactly 10,000) | 0.15 |
| `ROUND_TRIP` | Funds received then sent back out within 5 minutes | 0.45 |
| `FIRST_TIME_LARGE` | Large transfer from a source with no prior history | 0.35 |

Rules can be combined — a single transaction scoring multiple rules will have weights summed, capped at 1.0.

---

## Setup

### Prerequisites

- [Docker](https://docker.com) and Docker Compose
- Node.js 20+ (for local development)

### 1. Start Blnk Core

```bash
git clone https://github.com/blnkfinance/blnk && cd blnk
touch blnk.json
# paste the config from Blnk docs
docker compose up -d
```

### 2. Clone and configure this project

```bash
git clone https://github.com/<your-username>/blnk-anomaly-detector
cd blnk-anomaly-detector
cp .env.example .env
```

Edit `.env`:
```env
BLNK_BASE_URL=http://localhost:5001
RISK_THRESHOLD=0.6
PORT=3000
```

### 3. Install and run

```bash
npm install
npm run dev
```

The service starts on `http://localhost:3000`.

### 4. Configure Blnk webhook

In Blnk, create a webhook that points to your detector:

```bash
curl -X POST http://localhost:5001/hooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://host.docker.internal:3000/webhook/transaction",
    "events": ["transaction.applied"]
  }'
```

> If running inside Docker, use `host.docker.internal` to reach the host machine, or run both services on the same Docker network.

---

## Usage

### Dashboard

Open `http://localhost:3000` in your browser to see:
- Live count of flagged transactions
- Average risk score
- Breakdown by rule
- Full table of flagged transactions with scores and triggered rules

### Simulate a transaction (without Blnk webhooks)

Use the simulate panel in the dashboard, or call the API directly:

```bash
# Structuring example — just under $10,000
curl -X POST http://localhost:3000/api/simulate \
  -H "Content-Type: application/json" \
  -d '{"amount": 9500, "currency": "USD", "source": "balance_alice"}'

# Velocity spike — run this 6 times quickly
curl -X POST http://localhost:3000/api/simulate \
  -H "Content-Type: application/json" \
  -d '{"amount": 200, "source": "balance_alice"}'
```

### View flagged transactions via API

```bash
curl http://localhost:3000/api/flags
curl http://localhost:3000/api/stats
```

---

## What Gets Written to Blnk

When a transaction is flagged, the detector patches its metadata in Blnk:

```json
{
  "meta_data": {
    "anomaly_risk_score": 0.85,
    "anomaly_flags": ["STRUCTURING", "ROUND_NUMBER"],
    "anomaly_reviewed_at": "2026-04-06T12:00:00.000Z"
  }
}
```

This means the risk signal lives inside your ledger, queryable like any other metadata.

---

## Project Structure

```
blnk-anomaly-detector/
├── src/
│   ├── index.ts            # Express server: webhook listener + REST API
│   ├── anomaly-engine.ts   # All detection rules and scoring logic
│   ├── blnk-client.ts      # Typed wrapper around Blnk's REST API
│   └── flag-store.ts       # In-memory event store (replace with DB in prod)
├── dashboard/
│   └── index.html          # Live dashboard (vanilla HTML/JS, no build step)
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

## What a Production Version Would Look Like

This prototype makes a few simplifications worth noting:

- **In-memory store** → replace `flag-store.ts` with a Postgres table or Redis stream
- **Rule-based scoring** → augment with an ML model trained on labelled transaction history
- **Single instance** → the velocity check would need a shared Redis counter to work across multiple service instances
- **Alert delivery** → pipe flagged transactions to Slack, email, or a case management system

---

## Tech Stack

- **Runtime:** Node.js 20 / TypeScript
- **Framework:** Express
- **Ledger:** Blnk Core (Docker)
- **Dashboard:** Vanilla HTML/CSS/JS (no build step needed)

---

*Built as a technical assessment for the Blnk Finance Engineering/Moonshot Intern programme.*
