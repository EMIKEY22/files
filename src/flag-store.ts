import { AnomalyResult } from "./anomaly-engine";

// -----------------------------------------------------------------
// A simple in-memory store for flagged transactions.
// In a production system this would be a database table.
// -----------------------------------------------------------------

export interface FlaggedEvent {
  id: string;
  timestamp: string;
  transaction: {
    id: string;
    amount: number;
    currency: string;
    source: string;
    destination: string;
    reference: string;
  };
  result: AnomalyResult;
}

class FlagStore {
  private events: FlaggedEvent[] = [];

  add(event: FlaggedEvent): void {
    const exists = this.events.some(
      (e) => e.transaction.id === event.transaction.id
    );

    if (exists) return;

    this.events.unshift(event);
    if (this.events.length > 500) this.events.pop();
  }

  getAll(): FlaggedEvent[] {
    return this.events;
  }

  getRecent(limit = 50): FlaggedEvent[] {
    return this.events.slice(0, limit);
  }

  getStats() {
    const total = this.events.length;
    const byRule: Record<string, number> = {};

    for (const event of this.events) {
      for (const flag of event.result.flags) {
        byRule[flag.rule] = (byRule[flag.rule] ?? 0) + 1;
      }
    }

    const avgRisk =
      total === 0
        ? 0
        : this.events.reduce((sum, e) => sum + e.result.riskScore, 0) / total;

    return { total, byRule, avgRisk: parseFloat(avgRisk.toFixed(3)) };
  }
}

// Singleton export
export const flagStore = new FlagStore();

// -----------------------------------------------------------------
// Transaction store — logs every transaction we process
// so View Txns can show history without needing Blnk's search API
// -----------------------------------------------------------------

export interface StoredTransaction {
  id: string;
  amount: number;
  currency: string;
  source: string;
  destination: string;
  description: string;
  reference: string;
  timestamp: string;
  riskScore?: number;
  flagged?: boolean;
}

class TransactionStore {
  private txns: Map<string, StoredTransaction[]> = new Map();

  add(walletId: string, tx: StoredTransaction) {
    const existing = this.txns.get(walletId) ?? [];

    const alreadyExists = existing.some((item) => item.id === tx.id);
    if (alreadyExists) return;

    existing.unshift(tx);
    if (existing.length > 100) existing.pop();
    this.txns.set(walletId, existing);
  }

  get(walletId: string): StoredTransaction[] {
    return this.txns.get(walletId) ?? [];
  }
}

export const txStore = new TransactionStore();
