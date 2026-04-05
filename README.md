# Blnk Anomaly Detector

> A real-time transaction anomaly detection and wallet system built on top of [Blnk Finance](https://blnkfinance.com) — adding the risk signal layer that every financial product needs but Blnk doesn't ship by default.

![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)
![Node](https://img.shields.io/badge/Node.js-20-green)
![Blnk](https://img.shields.io/badge/Blnk-Core-orange)

---

## Overview

Blnk Core is a powerful open-source ledger — it records transactions immutably, enforces double-entry accounting, and exposes a clean REST API. But it has no opinion about whether a transaction *should* be happening.

This project extends Blnk with two things:

1. **A wallet system** — create wallets, deposit funds, and transfer between users, all recorded as real double-entry transactions in Blnk
2. **An anomaly detection layer** — every transaction is automatically scored against six financial crime detection rules, flagged transactions are displayed on a live dashboard, and risk scores are written back to Blnk as transaction metadata

---

## Features

- Create multi-currency wallets backed by real Blnk ledger balances
- Deposit and transfer funds with currency validation
- Real-time anomaly scoring via Blnk's `POST_TRANSACTION` hook
- Six detection rules covering structuring, velocity, round-tripping, and more
- Risk scores written back to Blnk transaction metadata
- Live dashboard showing flagged transactions, risk scores, and rule breakdown
- Simulate panel for testing detection rules without real transactions

---

## Architecture

```
┌─────────────────────────────────┐
│         Wallet UI               │
│    dashboard/wallet.html        │
└────────────┬────────────────────┘
             │ HTTP
             ▼
┌─────────────────────────────────┐
│     Anomaly Detector Service    │
│         (Express / TS)          │
│                                 │
│  POST /api/wallet/create        │
│  POST /api/wallet/deposit       │
│  POST /api/wallet/transfer  ────┼──► scores every transfer
│  POST /webhook/transaction  ◄───┼──── Blnk POST_TRANSACTION hook
│                                 │
│  anomaly-engine.ts  (6 rules)   │
│  flag-store.ts      (events)    │
│  blnk-client.ts     (API wrap)  │
│  wallet.ts          (wallet)    │
└────────────┬────────────────────┘
             │ REST API
             ▼
┌─────────────────────────────────┐
│         Blnk Core               │
│         (Docker)                │
│                                 │
│  Ledgers / Balances             │
│  Transactions (immutable)       │
│  Metadata (risk scores)         │
│  Hooks (POST_TRANSACTION)       │
└─────────────────────────────────┘
```

---

## Detection Rules

Each rule contributes a weight to a risk score from 0.0 to 1.0. A transaction is flagged when the score crosses the threshold (default: `0.5`). Rules stack — multiple signals on one transaction push the score higher.

| Rule | What it detects | Weight |
|------|----------------|--------|
| `STRUCTURING` | Amount within 5% below a reporting threshold (1k, 5k, 10k) | 0.50 |
| `VELOCITY_SPIKE` | More than 5 transactions from the same source in 10 minutes | 0.40 |
| `ROUND_TRIP` | Funds received then sent back out within 5 minutes | 0.45 |
| `FIRST_TIME_LARGE` | Large transfer (10k+) from a source with no prior history | 0.35 |
| `LARGE_TRANSFER` | Single transfer above 50,000 | 0.30 |
| `ROUND_NUMBER` | Suspiciously round amount above 5,000 | 0.15 |

**Example combinations:**

| Scenario | Rules triggered | Score |
|----------|----------------|-------|
| Transfer of 9,500 | STRUCTURING | 0.50 → flagged |
| 6 rapid transfers of 9,500 | STRUCTURING + VELOCITY | 0.90 → flagged |
| New wallet sends 15,000 | FIRST_TIME_LARGE | 0.35 → clean |
| New wallet sends 10,000 exactly | FIRST_TIME_LARGE + ROUND_NUMBER | 0.50 → flagged |

---

## Project Structure

```
blnk-anomaly-detector/
├── src/
│   ├── index.ts            # Express server — wallet API, webhook, dashboard API
│   ├── anomaly-engine.ts   # All 6 detection rules and scoring logic
│   ├── blnk-client.ts      # Typed wrapper around Blnk's REST API
│   ├── flag-store.ts       # In-memory store for flagged events
│   └── wallet.ts           # Wallet service — create, deposit, transfer
├── dashboard/
│   ├── index.html          # Anomaly detector dashboard
│   └── wallet.html         # Wallet management UI
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

## Setup

### Prerequisites

- [Docker Desktop](https://docker.com)
- [Node.js 20+](https://nodejs.org)

### 1. Start Blnk Core

```bash
git clone https://github.com/blnkfinance/blnk
cd blnk
```

Create `blnk.json`:
```json
{
  "project_name": "Blnk",
  "data_source": {
    "dns": "postgres://postgres:password@postgres:5432/blnk?sslmode=disable"
  },
  "redis": {
    "dns": "redis:6379"
  },
  "server": {
    "port": "5001"
  }
}
```

```bash
docker compose up
```

Verify Blnk is running: `http://localhost:5001/ledgers` should return `[]`.

### 2. Clone and configure this project

```bash
git clone https://github.com/<your-username>/blnk-anomaly-detector
cd blnk-anomaly-detector
cp .env.example .env
npm install
npm run dev
```

The service starts on `http://localhost:3000`.

### 3. Register the Blnk hook

This tells Blnk to notify the anomaly detector after every transaction:

```bash
curl -X POST http://localhost:5001/hooks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Anomaly Detector",
    "url": "http://host.docker.internal:3000/webhook/transaction",
    "type": "POST_TRANSACTION",
    "active": true,
    "timeout": 30,
    "retry_count": 3
  }'
```

> On Windows use `http://host.docker.internal:3000/...` or replace with your machine's local IP.

---

## Usage

### Wallet UI — `http://localhost:3000/wallet.html`

- **Create Wallet** — creates a Blnk ledger balance for a named user
- **Deposit** — funds flow from an internal funding pool into the wallet
- **Transfer** — moves money between wallets with currency validation
- **View Txns** — see transaction history per wallet

### Anomaly Dashboard — `http://localhost:3000`

- Live count of flagged transactions
- Average risk score across all flagged events
- Rule breakdown showing which rules fire most
- Full table with timestamps, amounts, risk scores, and triggered rules

### Simulate panel

Test detection rules without real wallet transactions:

```bash
# Structuring — just under $10,000
curl -X POST http://localhost:3000/api/simulate \
  -H "Content-Type: application/json" \
  -d '{"amount": 9500, "source": "balance_alice"}'

# Large transfer
curl -X POST http://localhost:3000/api/simulate \
  -H "Content-Type: application/json" \
  -d '{"amount": 60000, "source": "balance_alice"}'
```

---

## What Gets Written to Blnk

When a transaction is flagged, the risk score is patched back onto the transaction in Blnk as metadata:

```json
{
  "meta_data": {
    "anomaly_risk_score": 0.85,
    "anomaly_flags": ["STRUCTURING", "VELOCITY_SPIKE"],
    "anomaly_reviewed_at": "2026-04-06T12:00:00.000Z"
  }
}
```

This means risk signals live inside your ledger — queryable, auditable, and visible to any system reading Blnk.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/wallet/create` | Create a new wallet |
| POST | `/api/wallet/deposit` | Deposit funds into a wallet |
| POST | `/api/wallet/transfer` | Transfer between wallets |
| GET | `/api/wallet/:id` | Get balance and transactions |
| POST | `/webhook/transaction` | Blnk POST_TRANSACTION hook receiver |
| POST | `/api/simulate` | Simulate a transaction through the engine |
| GET | `/api/flags` | Get recent flagged transactions |
| GET | `/api/stats` | Get summary stats |

---

## Production Roadmap

This is a prototype — here's what a production version would add:

- **Persistent storage** — replace the in-memory flag store with a Postgres table
- **ML scoring** — augment rule-based detection with a model trained on labelled transaction history
- **Multi-instance velocity** — use Redis counters instead of in-memory maps so velocity checks work across horizontally scaled instances
- **Alert delivery** — pipe flagged transactions to Slack, PagerDuty, or a case management system
- **Cross-currency transfers** — add FX conversion layer for multi-currency wallet transfers
- **Review workflow** — let compliance teams mark flags as reviewed/dismissed

---

## Tech Stack

- **Runtime:** Node.js 20 / TypeScript
- **Framework:** Express
- **Ledger:** Blnk Core (Docker)
- **Dashboard:** Vanilla HTML/CSS/JS

---

*Built as a technical assessment for the Blnk Finance Engineering/Moonshot Intern programme.*
