import { BlnkClient, BlnkBalance, BlnkTransaction } from "./blnk-client";

export interface CreateWalletResult {
  walletId: string;
  ledgerId: string;
  owner: string;
  currency: string;
  balance: number;
}

export interface DepositResult {
  transactionId: string;
  walletId: string;
  amount: number;
  currency: string;
  newBalance: number;
}

export interface TransferResult {
  transactionId: string;
  fromWalletId: string;
  toWalletId: string;
  amount: number;
  currency: string;
}

export class WalletService {
  private blnk: BlnkClient;
  private ledgerId: string | null = null;
  private fundingPools: Map<string, string> = new Map();

  constructor(blnk: BlnkClient) {
    this.blnk = blnk;
  }

  private async getOrCreateLedger(): Promise<string> {
    if (this.ledgerId) return this.ledgerId;

    const ledger = await this.blnk.createLedger({
      name: "User Wallets",
      meta_data: { description: "Ledger for all user wallets" },
    });

    this.ledgerId = ledger.ledger_id;
    return this.ledgerId;
  }

  private async getOrCreateFundingPool(currency: string): Promise<string> {
    const existing = this.fundingPools.get(currency);
    if (existing) return existing;

    const ledgerId = await this.getOrCreateLedger();

    const balance = await this.blnk.createBalance({
      ledger_id: ledgerId,
      currency,
      overdraft_limit: 1000000000,
      meta_data: {
        type: "funding_pool",
        currency,
        description: "External funding source for deposits",
      },
    });

    this.fundingPools.set(currency, balance.balance_id);
    return balance.balance_id;
  }

  async createWallet(
    owner: string,
    currency: string = "USD"
  ): Promise<CreateWalletResult> {
    const ledgerId = await this.getOrCreateLedger();

    const balance = await this.blnk.createBalance({
      ledger_id: ledgerId,
      currency,
      meta_data: {
        owner,
        created_at: new Date().toISOString(),
        type: "user_wallet",
      },
    });

    return {
      walletId: balance.balance_id,
      ledgerId,
      owner,
      currency,
      balance:
        (balance.balance ?? 0) !== 0
          ? balance.balance
          : (balance.credit_balance ?? 0) - (balance.debit_balance ?? 0),
    };
  }

  async deposit(
    walletId: string,
    amount: number,
    currency: string = "USD"
  ): Promise<DepositResult> {
    const fundingPoolId = await this.getOrCreateFundingPool(currency);
    const reference = `deposit_${walletId}_${Date.now()}`;

    const tx = await this.blnk.createTransaction({
      amount,
      currency,
      reference,
      description: `Deposit to wallet ${walletId}`,
      source: fundingPoolId,
      destination: walletId,
      skip_queue: true,
      allow_overdraft: true,
      meta_data: { type: "deposit" },
    });

    const balance = await this.blnk.getBalance(walletId);
    const computedBalance =
      (balance.balance ?? 0) !== 0
        ? balance.balance
        : (balance.credit_balance ?? 0) - (balance.debit_balance ?? 0);

    return {
      transactionId: tx.transaction_id,
      walletId,
      amount,
      currency,
      newBalance: computedBalance,
    };
  }

  async transfer(
    fromWalletId: string,
    toWalletId: string,
    amount: number,
    currency: string = "USD"
  ): Promise<TransferResult> {
    const reference = `transfer_${fromWalletId}_${toWalletId}_${Date.now()}`;

    const tx = await this.blnk.createTransaction({
      amount,
      currency,
      reference,
      description: `Transfer from ${fromWalletId} to ${toWalletId}`,
      source: fromWalletId,
      destination: toWalletId,
      skip_queue: true,
      allow_overdraft: false,
      meta_data: { type: "transfer" },
    });

    return {
      transactionId: tx.transaction_id,
      fromWalletId,
      toWalletId,
      amount,
      currency,
    };
  }

  async getWallet(walletId: string): Promise<{
    balance: BlnkBalance;
    transactions: BlnkTransaction[];
  }> {
    const [balance, transactions] = await Promise.all([
      this.blnk.getBalance(walletId),
      this.blnk.getTransactionsForBalance(walletId, 20),
    ]);

    return { balance, transactions };
  }
}
