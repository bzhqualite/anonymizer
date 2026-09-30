import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type OrderStatus =
  | "awaiting_deposit" // en attente du dépôt de l'utilisateur
  | "expired" // aucun dépôt reçu avant l'expiration
  | "sweeping" // dépôt reçu, transfert vers le pool en cours
  | "processing" // paiements programmés vers les destinations
  | "completed"
  | "refunding" // dépôt hors limites : remboursement en cours
  | "refunded"
  | "flagged" // expéditeur ou destination sur liste de blocage : fonds gelés, revue manuelle
  | "failed";

export type TransferKind = "sweep" | "payout" | "fee" | "refund";
export type TransferStatus = "pending" | "sent" | "confirmed" | "failed";

export interface Order {
  id: string;
  status: OrderStatus;
  deposit_address: string;
  deposit_secret: string;
  destinations: string[];
  refund_address: string | null;
  sender: string | null;
  received: bigint | null;
  fee: bigint | null;
  created_at: number;
  expires_at: number;
  error: string | null;
}

export interface Transfer {
  id: number;
  order_id: string;
  kind: TransferKind;
  from_deposit: boolean;
  to_address: string;
  lamports: bigint;
  scheduled_at: number;
  status: TransferStatus;
  signature: string | null;
  raw_tx: string | null;
  last_valid_block_height: number | null;
  attempts: number;
  error: string | null;
}

type Row = Record<string, unknown>;

function toOrder(row: Row): Order {
  return {
    ...(row as unknown as Order),
    destinations: JSON.parse(row.destinations as string),
    received: row.received == null ? null : BigInt(row.received as string),
    fee: row.fee == null ? null : BigInt(row.fee as string),
  };
}

function toTransfer(row: Row): Transfer {
  return {
    ...(row as unknown as Transfer),
    from_deposit: row.from_deposit === 1,
    lamports: BigInt(row.lamports as string),
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        deposit_address TEXT NOT NULL UNIQUE,
        deposit_secret TEXT NOT NULL,
        destinations TEXT NOT NULL,
        refund_address TEXT,
        sender TEXT,
        received TEXT,
        fee TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL REFERENCES orders(id),
        kind TEXT NOT NULL,
        from_deposit INTEGER NOT NULL,
        to_address TEXT NOT NULL,
        lamports TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        signature TEXT,
        raw_tx TEXT,
        last_valid_block_height INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status, scheduled_at);
    `);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  createOrder(o: Pick<Order, "id" | "deposit_address" | "deposit_secret" | "destinations" | "refund_address" | "expires_at">) {
    this.db
      .prepare(
        `INSERT INTO orders (id, status, deposit_address, deposit_secret, destinations, refund_address, created_at, expires_at)
         VALUES (?, 'awaiting_deposit', ?, ?, ?, ?, ?, ?)`,
      )
      .run(o.id, o.deposit_address, o.deposit_secret, JSON.stringify(o.destinations), o.refund_address, Date.now(), o.expires_at);
  }

  getOrder(id: string): Order | undefined {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Row | undefined;
    return row && toOrder(row);
  }

  ordersByStatus(status: OrderStatus): Order[] {
    return (this.db.prepare("SELECT * FROM orders WHERE status = ?").all(status) as Row[]).map(toOrder);
  }

  updateOrder(id: string, fields: Partial<Pick<Order, "status" | "sender" | "received" | "fee" | "error">>) {
    const entries = Object.entries(fields).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v ?? null] as const);
    if (entries.length === 0) return;
    const sql = `UPDATE orders SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...entries.map(([, v]) => v as string | number | null), id);
  }

  addTransfer(t: Pick<Transfer, "order_id" | "kind" | "from_deposit" | "to_address" | "lamports" | "scheduled_at">) {
    this.db
      .prepare(
        `INSERT INTO transfers (order_id, kind, from_deposit, to_address, lamports, scheduled_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(t.order_id, t.kind, t.from_deposit ? 1 : 0, t.to_address, t.lamports.toString(), t.scheduled_at);
  }

  transfersForOrder(orderId: string): Transfer[] {
    return (this.db.prepare("SELECT * FROM transfers WHERE order_id = ? ORDER BY id").all(orderId) as Row[]).map(toTransfer);
  }

  dueTransfers(now: number): Transfer[] {
    return (
      this.db
        .prepare("SELECT * FROM transfers WHERE (status = 'pending' AND scheduled_at <= ?) OR status = 'sent' ORDER BY scheduled_at")
        .all(now) as Row[]
    ).map(toTransfer);
  }

  updateTransfer(
    id: number,
    fields: Partial<Pick<Transfer, "status" | "signature" | "raw_tx" | "last_valid_block_height" | "attempts" | "error">>,
  ) {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    const sql = `UPDATE transfers SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...entries.map(([, v]) => (v ?? null) as string | number | null), id);
  }
}
