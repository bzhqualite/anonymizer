import { Connection, Keypair } from "@solana/web3.js";
import type { Config } from "./config.ts";
import { decrypt } from "./crypto.ts";
import type { Order, Store, Transfer } from "./db.ts";
import { commission, distributable, MIN_PAYOUT, TX_FEE } from "./fees.ts";
import { buildTransfer, findSenders, getFinalizedBalance } from "./solana.ts";
import { randomDelay, randomSplit } from "./split.ts";

const MAX_ATTEMPTS = 5;

export class Engine {
  private running = false;

  constructor(
    private conn: Connection,
    private store: Store,
    private config: Config,
    private log: (msg: string) => void = console.log,
  ) {}

  start(intervalMs = 5_000) {
    const timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
    return () => clearInterval(timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const order of this.store.ordersByStatus("awaiting_deposit")) await this.guard(order, () => this.checkDeposit(order));
      await this.processTransfers();
      for (const order of this.store.ordersByStatus("sweeping")) await this.guard(order, () => this.afterSweep(order));
      for (const status of ["processing", "refunding"] as const) {
        for (const order of this.store.ordersByStatus(status)) this.checkCompletion(order);
      }
    } finally {
      this.running = false;
    }
  }

  private async guard(order: Order, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.log(`[order ${order.id}] erreur : ${(err as Error).message}`);
    }
  }

  // 1. Détection du dépôt
  private async checkDeposit(order: Order) {
    const balance = await getFinalizedBalance(this.conn, order.deposit_address);
    if (balance === 0n) {
      if (Date.now() > order.expires_at) this.store.updateOrder(order.id, { status: "expired" });
      return;
    }

    const senders = await findSenders(this.conn, order.deposit_address);
    const sender = senders[0] ?? null;
    this.store.updateOrder(order.id, { sender, received: balance });
    this.log(`[order ${order.id}] dépôt de ${balance} lamports reçu de ${sender}`);

    const blocked = [...senders, ...order.destinations].filter((a) => this.config.blocklist.has(a));
    if (blocked.length > 0) {
      this.store.updateOrder(order.id, { status: "flagged", error: `Adresse bloquée : ${blocked.join(", ")}` });
      this.log(`[order ${order.id}] GELÉ — adresse sur liste de blocage`);
      return;
    }

    const refundTo = order.refund_address ?? sender;
    const outOfBounds = balance < this.config.minDeposit || balance > this.config.maxDeposit;
    const tooSmall = distributable(balance, this.config.feeBps, order.destinations.length) < MIN_PAYOUT * BigInt(order.destinations.length);
    if (outOfBounds || tooSmall) {
      if (!refundTo || balance <= TX_FEE) {
        this.store.updateOrder(order.id, { status: "flagged", error: "Dépôt hors limites sans adresse de remboursement" });
        return;
      }
      this.store.transaction(() => {
        this.store.addTransfer({ order_id: order.id, kind: "refund", from_deposit: true, to_address: refundTo, lamports: balance - TX_FEE, scheduled_at: Date.now() });
        this.store.updateOrder(order.id, { status: "refunding", error: "Montant hors limites, remboursement" });
      });
      return;
    }

    // Le dépôt est rapatrié dans le pool : les paiements partent ensuite du pool, pas de l'adresse de dépôt.
    this.store.transaction(() => {
      this.store.addTransfer({
        order_id: order.id,
        kind: "sweep",
        from_deposit: true,
        to_address: this.config.pool.publicKey.toBase58(),
        lamports: balance - TX_FEE,
        scheduled_at: Date.now(),
      });
      this.store.updateOrder(order.id, { status: "sweeping" });
    });
  }

  // 2. Une fois le dépôt dans le pool : découpage aléatoire et programmation des paiements
  private async afterSweep(order: Order) {
    const sweep = this.store.transfersForOrder(order.id).find((t) => t.kind === "sweep");
    if (!sweep) return;
    if (sweep.status === "failed") {
      this.store.updateOrder(order.id, { status: "failed", error: sweep.error });
      return;
    }
    if (sweep.status !== "confirmed") return;

    const received = order.received!;
    const fee = commission(received, this.config.feeBps);
    const amounts = randomSplit(distributable(received, this.config.feeBps, order.destinations.length), order.destinations.length, MIN_PAYOUT);

    const now = Date.now();
    const schedule = amounts.map(() => now + randomDelay(this.config.maxPayoutDelayMs));
    this.store.transaction(() => {
      order.destinations.forEach((to, i) => {
        this.store.addTransfer({ order_id: order.id, kind: "payout", from_deposit: false, to_address: to, lamports: amounts[i], scheduled_at: schedule[i] });
      });
      if (this.config.treasury && fee > 0n) {
        this.store.addTransfer({
          order_id: order.id,
          kind: "fee",
          from_deposit: false,
          to_address: this.config.treasury.toBase58(),
          lamports: fee,
          scheduled_at: Math.max(...schedule) + randomDelay(this.config.maxPayoutDelayMs),
        });
      }
      this.store.updateOrder(order.id, { status: "processing", fee });
    });
    this.log(`[order ${order.id}] ${amounts.length} paiements programmés, commission ${fee} lamports`);
  }

  private checkCompletion(order: Order) {
    const transfers = this.store.transfersForOrder(order.id);
    const failed = transfers.find((t) => t.status === "failed");
    if (failed) {
      this.store.updateOrder(order.id, { status: "failed", error: failed.error });
    } else if (transfers.every((t) => t.status === "confirmed")) {
      this.store.updateOrder(order.id, { status: order.status === "refunding" ? "refunded" : "completed" });
    }
  }

  // 3. Exécution idempotente des transferts
  private async processTransfers() {
    for (const t of this.store.dueTransfers(Date.now())) {
      try {
        if (t.status === "pending") await this.send(t);
        else await this.reconcile(t);
      } catch (err) {
        this.log(`[transfer ${t.id}] erreur : ${(err as Error).message}`);
      }
    }
  }

  private signerFor(t: Transfer): Keypair {
    if (!t.from_deposit) return this.config.pool;
    const order = this.store.getOrder(t.order_id)!;
    return Keypair.fromSecretKey(decrypt(order.deposit_secret, this.config.masterKey));
  }

  private async send(t: Transfer) {
    if (t.attempts >= MAX_ATTEMPTS) {
      this.store.updateTransfer(t.id, { status: "failed" });
      return;
    }
    const built = await buildTransfer(this.conn, this.signerFor(t), t.to_address, t.lamports);
    // La tx signée est enregistrée AVANT diffusion : après un crash on la retrouve au lieu de repayer.
    this.store.updateTransfer(t.id, {
      status: "sent",
      signature: built.signature,
      raw_tx: built.raw,
      last_valid_block_height: built.lastValidBlockHeight,
      attempts: t.attempts + 1,
    });
    try {
      await this.conn.sendRawTransaction(Buffer.from(built.raw, "base64"), { maxRetries: 3 });
      this.log(`[transfer ${t.id}] ${t.kind} ${t.lamports} lamports → ${t.to_address} (${built.signature})`);
    } catch (err) {
      this.store.updateTransfer(t.id, { error: (err as Error).message });
      throw err;
    }
  }

  private async reconcile(t: Transfer) {
    const { value } = await this.conn.getSignatureStatuses([t.signature!], { searchTransactionHistory: true });
    const status = value[0];
    if (status?.err) {
      this.store.updateTransfer(t.id, { status: "pending", error: JSON.stringify(status.err) });
      return;
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      this.store.updateTransfer(t.id, { status: "confirmed", raw_tx: null });
      return;
    }
    const height = await this.conn.getBlockHeight("confirmed");
    if (height > t.last_valid_block_height!) {
      // Blockhash expiré sans inclusion : la tx ne passera jamais, on peut en reconstruire une.
      this.store.updateTransfer(t.id, { status: "pending" });
    } else {
      await this.conn.sendRawTransaction(Buffer.from(t.raw_tx!, "base64"), { skipPreflight: true, maxRetries: 0 });
    }
  }
}
