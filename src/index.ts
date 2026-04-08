import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { BlnkClient, BlnkTransaction } from "./blnk-client";
import { AnomalyEngine } from "./anomaly-engine";
import { flagStore, FlaggedEvent, txStore, StoredTransaction } from "./flag-store";
import { WalletService } from "./wallet";

// -----------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dashboard")));

const blnk = new BlnkClient(
  process.env.BLNK_BASE_URL ?? "http://localhost:5001",
  process.env.BLNK_SECRET_KEY
);

const engine = new AnomalyEngine(
  parseFloat(process.env.RISK_THRESHOLD ?? "0.5")
);
const serverInstanceId = `server_${Date.now()}`;
const walletService = new WalletService(blnk);
const processedTransactionIds = new Set<string>();
const frozenWallets = new Set<string>();
// -----------------------------------------------------------------
// Helper — score a transaction and store if flagged
// -----------------------------------------------------------------

function scoreAndStore(tx: BlnkTransaction, history: BlnkTransaction[] = []) {
  const result = engine.analyze(tx, history);

  console.log(`[engine] tx=${tx.transaction_id} score=${result.riskScore} flagged=${result.flagged}`);

  // Always store the transaction for View Txns whether flagged or not
  const stored: StoredTransaction = {
    id: tx.transaction_id,
    amount: tx.amount,
    currency: tx.currency,
    source: tx.source,
    destination: tx.destination,
    description: tx.description ?? "",
    reference: tx.reference,
    timestamp: tx.created_at,
    riskScore: result.riskScore,
    flagged: result.flagged,
  };
  txStore.add(tx.source, stored);
  txStore.add(tx.destination, stored);

  if (result.flagged) {
  console.warn(
    `[ALERT] Suspicious! id=${tx.transaction_id} score=${result.riskScore} rules=${result.flags
      .map(f => f.rule)
      .join(", ")}`
  );

  flagStore.add({
    id: `flag_${Date.now()}`,
    timestamp: new Date().toISOString(),
    transaction: {
      id: tx.transaction_id,
      amount: tx.amount,
      currency: tx.currency,
      source: tx.source,
      destination: tx.destination,
      reference: tx.reference,
    },
    result,
  });

  //auto-freeze wallet for very high risk
  const txType = tx.meta_data?.type;

  if (result.riskScore >= 0.8 && txType === "transfer") {
    frozenWallets.add(tx.source);
    console.log(`[SECURITY] Wallet ${tx.source} has been frozen due to high-risk transaction ${tx.transaction_id}`);
  }

  // Tag transaction in Blnk metadata
  blnk
    .tagTransactionRisk(
      tx.transaction_id,
      result.riskScore,
      result.flags.map(f => f.rule)
    )
    .catch(() => {});
  }

  return result;
}

// -----------------------------------------------------------------
// Webhook — receives POST_TRANSACTION hooks from Blnk
// Blnk hook: POST http://host.docker.internal:3000/webhook/transaction
// -----------------------------------------------------------------

app.post("/webhook/transaction", async (req: Request, res: Response) => {
  res.status(200).json({ received: true });

  const payload = req.body;
  const txData: BlnkTransaction | undefined = payload?.data ?? payload;

  if (!txData?.transaction_id) return;
  if (txData.status && !["APPLIED", "COMMIT"].includes(txData.status)) return;

  if (processedTransactionIds.has(txData.transaction_id)) {
    console.log(`[webhook] Skipping duplicate transaction ${txData.transaction_id}`);
    return;
  }

  processedTransactionIds.add(txData.transaction_id);
  console.log(`[webhook] Received transaction ${txData.transaction_id}`);

  try {
    let history: BlnkTransaction[] = [];
    if (txData.source && !txData.source.startsWith("@")) {
      history = await blnk.getTransactionsForBalance(txData.source, 50);
    }
    scoreAndStore(txData, history);
  } catch (err) {
    console.error("[webhook] Error:", err);
  }
});

// -----------------------------------------------------------------
// Anomaly dashboard API
// -----------------------------------------------------------------

app.get("/api/flags", (_req: Request, res: Response) => {
  res.json(flagStore.getRecent(50));
});

app.get("/api/stats", (_req: Request, res: Response) => {
  res.json(flagStore.getStats());
});

app.post("/api/simulate", async (req: Request, res: Response) => {
  const tx: BlnkTransaction = {
    transaction_id: `sim_${Date.now()}`,
    amount: req.body.amount ?? 9500,
    currency: req.body.currency ?? "USD",
    reference: `sim_ref_${Date.now()}`,
    description: req.body.description ?? "Simulated transaction",
    status: "APPLIED",
    source: req.body.source ?? "balance_sim_source",
    destination: req.body.destination ?? "balance_sim_dest",
    created_at: new Date().toISOString(),
    meta_data: {},
  };

  const result = scoreAndStore(tx, req.body.history ?? []);
  res.json({ transaction: tx, result });
});

// -----------------------------------------------------------------
// Wallet API
// -----------------------------------------------------------------

app.post("/api/wallet/create", async (req: Request, res: Response) => {
  try {
    const { owner, currency } = req.body;
    if (!owner) { res.status(400).json({ error: "owner is required" }); return; }

    const wallet = await walletService.createWallet(owner, currency ?? "USD");
    console.log(`[wallet] Created wallet for ${owner}: ${wallet.walletId}`);
    res.json(wallet);
  } catch (err: any) {
    console.error("[wallet] Create error:", err?.response?.data ?? err.message);
    res.status(500).json({ error: err?.response?.data ?? err.message });
  }
});

app.post("/api/wallet/deposit", async (req: Request, res: Response) => {
  try {
    const { walletId, amount, currency } = req.body;
    if (!walletId || !amount) { res.status(400).json({ error: "walletId and amount are required" }); return; }

    if (frozenWallets.has(walletId)) {
      res.status(403).json({
        error: `Wallet ${walletId} is frozen and cannot receive deposits`
      });
      return;
    }

    // Validate currency matches the wallet's currency
    const walletData = await blnk.getBalance(walletId);
    const walletCurrency = walletData.currency;
    const requestedCurrency = currency ?? "USD";

    if (walletCurrency !== requestedCurrency) {
      res.status(400).json({
        error: `Currency mismatch — wallet is ${walletCurrency} but you're depositing ${requestedCurrency}`
      });
      return;
    }

    const result = await walletService.deposit(walletId, amount, requestedCurrency);
    console.log(`[wallet] Deposited ${amount} to ${walletId}`);
    res.json(result);
  } catch (err: any) {
    console.error("[wallet] Deposit error:", err?.response?.data ?? err.message);
    res.status(500).json({ error: err?.response?.data ?? err.message });
  }
});

app.post("/api/wallet/transfer", async (req: Request, res: Response) => {
  try {
    const { fromWalletId, toWalletId, amount, currency } = req.body;
    if (frozenWallets.has(fromWalletId)) {
      res.status(403).json({
        error: `Wallet ${fromWalletId} is frozen and cannot send transfers`
      });
      return;
    }

    if (frozenWallets.has(toWalletId)) {
      res.status(403).json({
        error: `Wallet ${toWalletId} is frozen and cannot receive transfers`
      });
      return;
    }
    if (!fromWalletId || !toWalletId || !amount) {
      res.status(400).json({ error: "fromWalletId, toWalletId and amount are required" });
      return;
    }

    // Validate both wallets are the same currency
    const [fromWallet, toWallet] = await Promise.all([
      blnk.getBalance(fromWalletId),
      blnk.getBalance(toWalletId),
    ]);

    if (fromWallet.currency !== toWallet.currency) {
      res.status(400).json({
        error: `Currency mismatch — source wallet is ${fromWallet.currency} but destination is ${toWallet.currency}`
      });
      return;
    }

    const result = await walletService.transfer(fromWalletId, toWalletId, amount, fromWallet.currency);
    console.log(`[wallet] Transferred ${amount} from ${fromWalletId} to ${toWalletId}`);
    res.json(result);
  } catch (err: any) {
    console.error("[wallet] Transfer error:", err?.response?.data ?? err.message);
    res.status(500).json({ error: err?.response?.data ?? err.message });
  }
});

app.get("/api/wallet/:walletId", async (req: Request, res: Response) => {
  try {
    const { walletId } = req.params;

    const balance = await blnk.getBalance(walletId);
    const transactions = txStore.get(walletId);

    res.json({ balance, transactions });
  } catch (err: any) {
    console.error("[wallet] Get error:", err?.response?.data ?? err.message);
    res.status(500).json({ error: err?.response?.data ?? err.message });
  }
});

app.post("/api/wallet/unfreeze", (req: Request, res: Response) => {
  const { walletId } = req.body;

  if (!walletId) {
    res.status(400).json({ error: "walletId is required" });
    return;
  }

  if (!frozenWallets.has(walletId)) {
    res.status(404).json({ error: "Wallet is not frozen" });
    return;
  }

  frozenWallets.delete(walletId);

  console.log(`[SECURITY] Wallet ${walletId} has been unfrozen`);

  res.json({
    success: true,
    message: `Wallet ${walletId} has been unfrozen`,
  });
});

app.get("/api/frozen-wallets", (_req: Request, res: Response) => {
  res.json({
    frozenWallets: [...frozenWallets]
  });
});

app.get("/api/session", (_req: Request, res: Response) => {
  res.json({ serverInstanceId });
});

// -----------------------------------------------------------------
// Start
// -----------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.log(`\n🔍 Blnk Anomaly Detector running on http://localhost:${PORT}`);
  console.log(`   Webhook:   POST http://localhost:${PORT}/webhook/transaction`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Wallet:    POST http://localhost:${PORT}/api/wallet/create\n`);
});

export default app;
