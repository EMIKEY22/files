import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { BlnkClient, BlnkTransaction } from "./blnk-client";
import { AnomalyEngine } from "./anomaly-engine";
import { flagStore, FlaggedEvent } from "./flag-store";
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

const walletService = new WalletService(blnk);

// -----------------------------------------------------------------
// Helper — score a transaction and store if flagged
// -----------------------------------------------------------------

function scoreAndStore(tx: BlnkTransaction, history: BlnkTransaction[] = []) {
  const result = engine.analyze(tx, history);

  console.log(`[engine] tx=${tx.transaction_id} score=${result.riskScore} flagged=${result.flagged}`);

  if (result.flagged) {
    console.warn(`[ALERT] Suspicious! id=${tx.transaction_id} score=${result.riskScore} rules=${result.flags.map(f => f.rule).join(", ")}`);

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

    // Best-effort: tag the transaction in Blnk with risk metadata
    blnk.tagTransactionRisk(tx.transaction_id, result.riskScore, result.flags.map(f => f.rule))
      .catch(() => {}); // don't block if this fails
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

    const result = await walletService.deposit(walletId, amount, currency ?? "USD");
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
    if (!fromWalletId || !toWalletId || !amount) {
      res.status(400).json({ error: "fromWalletId, toWalletId and amount are required" });
      return;
    }

    const result = await walletService.transfer(fromWalletId, toWalletId, amount, currency ?? "USD");
    console.log(`[wallet] Transferred ${amount} from ${fromWalletId} to ${toWalletId}`);

    // Directly score the transaction through the anomaly engine.
    // In production this would fire automatically via Blnk's POST_TRANSACTION hook.
    res.json(result);
  } catch (err: any) {
    console.error("[wallet] Transfer error:", err?.response?.data ?? err.message);
    res.status(500).json({ error: err?.response?.data ?? err.message });
  }
});

app.get("/api/wallet/:walletId", async (req: Request, res: Response) => {
  try {
    const { walletId } = req.params;
    const result = await walletService.getWallet(walletId);
    res.json(result);
  } catch (err: any) {
    console.error("[wallet] Get error:", err?.response?.data ?? err.message);
    res.status(500).json({ error: err?.response?.data ?? err.message });
  }
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
