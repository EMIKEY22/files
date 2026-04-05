import { BlnkTransaction } from "./blnk-client";

// -----------------------------------------------------------------
// Types
// -----------------------------------------------------------------

export interface AnomalyResult {
  transactionId: string;
  riskScore: number;       // 0.0 (clean) → 1.0 (highly suspicious)
  flags: AnomalyFlag[];
  flagged: boolean;        // true if riskScore >= threshold
}

export interface AnomalyFlag {
  rule: string;
  detail: string;
  weight: number;          // how much this rule contributes to the score
}

// -----------------------------------------------------------------
// Rule configuration (tweak these to tune sensitivity)
// -----------------------------------------------------------------

const RULES = {
  // More than this many transactions from the same source in a short window = velocity spike
  VELOCITY_WINDOW_MINUTES: 10,
  VELOCITY_MAX_TRANSACTIONS: 5,

  // Transactions just below common reporting thresholds are suspicious (structuring)
  STRUCTURING_THRESHOLDS: [10000, 5000, 1000],
  STRUCTURING_MARGIN: 0.05, // within 5% below threshold = suspicious

  // Very large single transfer
  LARGE_TRANSFER_AMOUNT: 50000,

  // Round numbers above a certain size are slightly suspicious
  ROUND_NUMBER_MIN: 5000,
};

// -----------------------------------------------------------------
// Anomaly Engine
// -----------------------------------------------------------------

export class AnomalyEngine {
  private threshold: number;

  // recentTransactions: a rolling in-memory window of recent transactions
  // keyed by source balance ID. In production you'd back this with Redis.
  private recentBySource: Map<string, BlnkTransaction[]> = new Map();

  constructor(threshold: number = 0.5) {
    this.threshold = threshold;
  }

  // Main entry point: score a single transaction
  analyze(
    tx: BlnkTransaction,
    history: BlnkTransaction[]
  ): AnomalyResult {
    // Add this transaction to the internal memory so velocity
    // checks work across multiple simulate calls
    const existing = this.recentBySource.get(tx.source) ?? [];
    existing.push(tx);
    this.recentBySource.set(tx.source, existing);

    // Merge passed-in history with internal memory
    const combined = [...history, ...existing.filter(h => h.transaction_id !== tx.transaction_id)];

    const flags: AnomalyFlag[] = [];

    const velocityFlag = this.checkVelocity(tx, combined);
    if (velocityFlag) flags.push(velocityFlag);

    const structuringFlag = this.checkStructuring(tx);
    if (structuringFlag) flags.push(structuringFlag);

    const largeFlag = this.checkLargeTransfer(tx);
    if (largeFlag) flags.push(largeFlag);

    const roundFlag = this.checkRoundNumber(tx);
    if (roundFlag) flags.push(roundFlag);

    const roundTripFlag = this.checkRoundTrip(tx, combined);
    if (roundTripFlag) flags.push(roundTripFlag);

    const firstTimeLargeFlag = this.checkFirstTimeLargeTransfer(tx, combined);
    if (firstTimeLargeFlag) flags.push(firstTimeLargeFlag);

    const riskScore = Math.min(
      flags.reduce((sum, f) => sum + f.weight, 0),
      1.0
    );

    return {
      transactionId: tx.transaction_id,
      riskScore: parseFloat(riskScore.toFixed(3)),
      flags,
      flagged: riskScore >= this.threshold,
    };
  }
  // ── Rule implementations ──────────────────────────────────────

  private checkVelocity(
    tx: BlnkTransaction,
    history: BlnkTransaction[]
  ): AnomalyFlag | null {
    const windowStart = new Date(
      new Date(tx.created_at).getTime() -
        RULES.VELOCITY_WINDOW_MINUTES * 60 * 1000
    );

    // Count how many recent transactions share the same source
    const recentCount = history.filter(
      (h) =>
        h.source === tx.source &&
        new Date(h.created_at) >= windowStart &&
        h.transaction_id !== tx.transaction_id
    ).length;

    if (recentCount >= RULES.VELOCITY_MAX_TRANSACTIONS) {
      return {
        rule: "VELOCITY_SPIKE",
        detail: `${recentCount + 1} transactions from same source in ${RULES.VELOCITY_WINDOW_MINUTES} minutes`,
        weight: 0.4,
      };
    }
    return null;
  }

  private checkStructuring(tx: BlnkTransaction): AnomalyFlag | null {
    for (const threshold of RULES.STRUCTURING_THRESHOLDS) {
      const lowerBound = threshold * (1 - RULES.STRUCTURING_MARGIN);
      if (tx.amount >= lowerBound && tx.amount < threshold) {
        return {
          rule: "STRUCTURING",
          detail: `Amount ${tx.amount} is just below reporting threshold of ${threshold}`,
          weight: 0.5,
        };
      }
    }
    return null;
  }

  private checkLargeTransfer(tx: BlnkTransaction): AnomalyFlag | null {
    if (tx.amount >= RULES.LARGE_TRANSFER_AMOUNT) {
      return {
        rule: "LARGE_TRANSFER",
        detail: `Single transfer of ${tx.amount} exceeds large transfer threshold`,
        weight: 0.3,
      };
    }
    return null;
  }

  private checkRoundNumber(tx: BlnkTransaction): AnomalyFlag | null {
    if (tx.amount >= RULES.ROUND_NUMBER_MIN && tx.amount % 1000 === 0) {
      return {
        rule: "ROUND_NUMBER",
        detail: `Suspiciously round amount: ${tx.amount}`,
        weight: 0.15,
      };
    }
    return null;
  }

  private checkRoundTrip(
    tx: BlnkTransaction,
    history: BlnkTransaction[]
  ): AnomalyFlag | null {
    // Look for a recent inbound transaction of the same amount to the source balance
    const fiveMinutesAgo = new Date(
      new Date(tx.created_at).getTime() - 5 * 60 * 1000
    );

    const inbound = history.find(
      (h) =>
        h.destination === tx.source &&
        Math.abs(h.amount - tx.amount) < 0.01 &&
        new Date(h.created_at) >= fiveMinutesAgo &&
        h.transaction_id !== tx.transaction_id
    );

    if (inbound) {
      return {
        rule: "ROUND_TRIP",
        detail: `Funds received then immediately sent out (possible layering)`,
        weight: 0.45,
      };
    }
    return null;
  }

  private checkFirstTimeLargeTransfer(
    tx: BlnkTransaction,
    history: BlnkTransaction[]
  ): AnomalyFlag | null {
    const isLarge = tx.amount >= 10000;
    const hasHistory = history.some(
      (h) => h.source === tx.source && h.transaction_id !== tx.transaction_id
    );

    if (isLarge && !hasHistory) {
      return {
        rule: "FIRST_TIME_LARGE",
        detail: `Large transfer from a source with no prior transaction history`,
        weight: 0.35,
      };
    }
    return null;
  }
}
