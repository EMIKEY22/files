import axios, { AxiosInstance } from "axios";

// -----------------------------------------------------------------
// Types
// -----------------------------------------------------------------

export interface BlnkTransaction {
  transaction_id: string;
  amount: number;
  currency: string;
  reference: string;
  description: string;
  status: "QUEUED" | "APPLIED" | "INFLIGHT" | "VOID" | "REJECTED";
  source: string;
  destination: string;
  created_at: string;
  meta_data?: Record<string, unknown>;
}

export interface BlnkBalance {
  balance_id: string;
  balance: number;
  credit_balance: number;
  debit_balance: number;
  currency: string;
  ledger_id: string;
  created_at: string;
  meta_data?: Record<string, unknown>;
}

export interface BlnkLedger {
  ledger_id: string;
  name: string;
  created_at: string;
  meta_data?: Record<string, unknown>;
}

export interface CreateLedgerInput {
  name: string;
  meta_data?: Record<string, unknown>;
}

export interface CreateBalanceInput {
  ledger_id: string;
  currency: string;
  overdraft_limit?: number;
  meta_data?: Record<string, unknown>;
}

export interface CreateTransactionInput {
  amount: number;
  currency: string;
  reference: string;
  description: string;
  source: string;
  destination: string;
  skip_queue?: boolean;
  allow_overdraft?: boolean;
  meta_data?: Record<string, unknown>;
}

// -----------------------------------------------------------------
// Client
// -----------------------------------------------------------------

export class BlnkClient {
  private http: AxiosInstance;

  constructor(baseURL: string, secretKey?: string) {
    this.http = axios.create({
      baseURL,
      headers: {
        "Content-Type": "application/json",
        ...(secretKey ? { "X-Blnk-Key": secretKey } : {}),
      },
    });
  }

  async createLedger(input: CreateLedgerInput): Promise<BlnkLedger> {
    const res = await this.http.post<BlnkLedger>("/ledgers", input);
    return res.data;
  }

  async createBalance(input: CreateBalanceInput): Promise<BlnkBalance> {
    const res = await this.http.post<BlnkBalance>("/balances", input);
    return res.data;
  }

  async getBalance(balanceId: string): Promise<BlnkBalance> {
    const res = await this.http.get<BlnkBalance>(`/balances/${balanceId}`);
    return res.data;
  }

  async getTransactionsForBalance(
    balanceId: string,
    limit = 50
  ): Promise<BlnkTransaction[]> {
    return [];

    }

  async createTransaction(input: CreateTransactionInput): Promise<BlnkTransaction> {
    try {
      const res = await this.http.post<BlnkTransaction>("/transactions", input);
      return res.data;
    } catch (err) {
      console.error("[blnk] createTransaction failed:", err);
      // Endpoint may not be available — throw an error
      throw new Error("Failed to create transaction");
    }
  }

  async getTransaction(transactionId: string): Promise<BlnkTransaction> {
    const res = await this.http.get<BlnkTransaction>(`/transactions/${transactionId}`);
    return res.data;
  }

  async tagTransactionRisk(
    transactionId: string,
    riskScore: number,
    flags: string[]
  ): Promise<void> {
    await this.http.post(`/${transactionId}/metadata`, {
      meta_data: {
        anomaly_risk_score: riskScore,
        anomaly_flags: flags,
        anomaly_reviewed_at: new Date().toISOString(),
      },
    });

    }
}
