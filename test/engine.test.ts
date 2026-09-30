import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Keypair, SystemInstruction, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import type { Config } from "../src/config.ts";
import { encrypt } from "../src/crypto.ts";
import { Store } from "../src/db.ts";
import { Engine } from "../src/engine.ts";
import { TX_FEE } from "../src/fees.ts";

/** Faux RPC Solana en mémoire : applique les transferts système et facture TX_FEE au payeur. */
class FakeChain {
  balances = new Map<string, bigint>();
  history = new Map<string, { signature: string; source: string; destination: string }[]>();
  landed = new Set<string>();
  sent: { from: string; to: string; lamports: bigint }[] = [];

  credit(from: string, to: string, lamports: bigint) {
    this.balances.set(to, (this.balances.get(to) ?? 0n) + lamports);
    const sig = bs58.encode(randomBytes(64));
    const entry = { signature: sig, source: from, destination: to };
    this.history.set(to, [...(this.history.get(to) ?? []), entry]);
  }

  connection() {
    const chain = this;
    return {
      async getBalance(pk: { toBase58(): string }) {
        return Number(chain.balances.get(pk.toBase58()) ?? 0n);
      },
      async getSignaturesForAddress(pk: { toBase58(): string }) {
        return (chain.history.get(pk.toBase58()) ?? []).map((h) => ({ signature: h.signature, err: null })).reverse();
      },
      async getParsedTransaction(sig: string) {
        const h = [...chain.history.values()].flat().find((e) => e.signature === sig)!;
        return {
          transaction: {
            message: {
              instructions: [{ programId: SystemProgram.programId, parsed: { type: "transfer", info: { source: h.source, destination: h.destination } } }],
            },
          },
        };
      },
      async getLatestBlockhash() {
        return { blockhash: bs58.encode(randomBytes(32)), lastValidBlockHeight: 1000 };
      },
      async getBlockHeight() {
        return 10;
      },
      async sendRawTransaction(raw: Buffer) {
        const tx = Transaction.from(raw);
        const sig = bs58.encode(tx.signature!);
        if (chain.landed.has(sig)) return sig;
        const { fromPubkey, toPubkey, lamports } = SystemInstruction.decodeTransfer(tx.instructions[0]);
        const from = fromPubkey.toBase58();
        const cost = BigInt(lamports) + TX_FEE;
        const balance = chain.balances.get(from) ?? 0n;
        if (balance < cost) throw new Error(`insufficient funds ${from}`);
        chain.balances.set(from, balance - cost);
        chain.credit(from, toPubkey.toBase58(), BigInt(lamports));
        chain.landed.add(sig);
        chain.sent.push({ from, to: toPubkey.toBase58(), lamports: BigInt(lamports) });
        return sig;
      },
      async getSignatureStatuses(sigs: string[]) {
        return { value: sigs.map((s) => (chain.landed.has(s) ? { err: null, confirmationStatus: "confirmed" } : null)) };
      },
    } as unknown as Connection;
  }
}

function setup(overrides: Partial<Config> = {}) {
  const pool = Keypair.generate();
  const treasury = Keypair.generate().publicKey;
  const config = {
    rpcUrl: "fake",
    port: 0,
    masterKey: randomBytes(32),
    pool,
    treasury,
    feeBps: 100n,
    minDeposit: 100_000_000n,
    maxDeposit: 100_000_000_000n,
    maxDestinations: 5,
    orderTtlMs: 60_000,
    maxPayoutDelayMs: 0,
    blocklist: new Set<string>(),
    dbPath: ":memory:",
    ...overrides,
  } as Config;
  const chain = new FakeChain();
  chain.balances.set(pool.publicKey.toBase58(), 10_000_000n); // réserve de frais du pool
  const store = new Store(":memory:");
  const engine = new Engine(chain.connection(), store, config, () => {});
  return { config, chain, store, engine };
}

function newOrder(store: Store, config: Config, destinations: string[]) {
  const deposit = Keypair.generate();
  const id = crypto.randomUUID();
  store.createOrder({
    id,
    deposit_address: deposit.publicKey.toBase58(),
    deposit_secret: encrypt(deposit.secretKey, config.masterKey),
    destinations,
    refund_address: null,
    expires_at: Date.now() + 60_000,
  });
  return { id, depositAddress: deposit.publicKey.toBase58() };
}

async function run(engine: Engine, ticks = 10) {
  for (let i = 0; i < ticks; i++) await engine.tick();
}

test("2 SOL répartis aléatoirement sur 3 wallets, commission à la trésorerie", async () => {
  const { config, chain, store, engine } = setup();
  const dests = [1, 2, 3].map(() => Keypair.generate().publicKey.toBase58());
  const user = Keypair.generate().publicKey.toBase58();
  const { id, depositAddress } = newOrder(store, config, dests);

  chain.credit(user, depositAddress, 2_000_000_000n);
  await run(engine);

  const order = store.getOrder(id)!;
  assert.equal(order.status, "completed");
  assert.equal(order.sender, user);
  assert.equal(order.fee, 20_000_000n);

  const received = dests.map((d) => chain.balances.get(d) ?? 0n);
  const total = received.reduce((a, b) => a + b, 0n);
  assert.equal(total, 2_000_000_000n - 20_000_000n - 5n * TX_FEE);
  assert.equal(new Set(received).size, 3, "les 3 montants doivent différer");
  assert.equal(chain.balances.get(config.treasury!.toBase58()), 20_000_000n);
  assert.equal(chain.balances.get(depositAddress), 0n);

  // Les destinations sont payées par le pool, jamais directement par l'adresse de dépôt
  for (const d of dests) assert.equal(chain.sent.find((s) => s.to === d)!.from, config.pool.publicKey.toBase58());
  // Le pool retrouve sa réserve initiale (frais couverts par le dépôt)
  assert.equal(chain.balances.get(config.pool.publicKey.toBase58()), 10_000_000n);
});

test("un dépôt hors limites est remboursé à l'expéditeur", async () => {
  const { config, chain, store, engine } = setup();
  const user = Keypair.generate().publicKey.toBase58();
  const { id, depositAddress } = newOrder(store, config, [Keypair.generate().publicKey.toBase58()]);

  chain.credit(user, depositAddress, 50_000_000n);
  await run(engine);

  assert.equal(store.getOrder(id)!.status, "refunded");
  assert.equal(chain.balances.get(user), 50_000_000n - TX_FEE);
});

test("un expéditeur sur liste de blocage gèle l'ordre", async () => {
  const user = Keypair.generate().publicKey.toBase58();
  const { config, chain, store, engine } = setup({ blocklist: new Set([user]) });
  const { id, depositAddress } = newOrder(store, config, [Keypair.generate().publicKey.toBase58()]);

  chain.credit(user, depositAddress, 1_000_000_000n);
  await run(engine);

  assert.equal(store.getOrder(id)!.status, "flagged");
  assert.equal(chain.sent.length, 0);
  assert.equal(chain.balances.get(depositAddress), 1_000_000_000n);
});

test("un ordre sans dépôt expire", async () => {
  const { config, store, engine } = setup({ orderTtlMs: 0 });
  const { id } = newOrder(store, config, [Keypair.generate().publicKey.toBase58()]);
  const db = store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } };
  db.db.prepare("UPDATE orders SET expires_at = ? WHERE id = ?").run(Date.now() - 1, id);
  await run(engine, 1);
  assert.equal(store.getOrder(id)!.status, "expired");
});
