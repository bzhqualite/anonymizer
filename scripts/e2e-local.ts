/**
 * Scénario complet sur le nœud local : un trader envoie 2 SOL, 3 wallets de destination.
 * Utilise le vrai serveur HTTP, le vrai worker et le vrai client RPC @solana/web3.js.
 *
 *   npm run e2e
 */
import { randomBytes } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { startLocalValidator } from "./local-validator.ts";

const rpc = await startLocalValidator(8898);
const pool = Keypair.generate();
const treasury = Keypair.generate();
Object.assign(process.env, {
  SOLANA_RPC_URL: rpc.url,
  MASTER_KEY: randomBytes(32).toString("hex"),
  POOL_SECRET_KEY: bs58.encode(pool.secretKey),
  TREASURY_ADDRESS: treasury.publicKey.toBase58(),
  FEE_BPS: "100",
  MAX_PAYOUT_DELAY_MINUTES: "0.25",
  DB_PATH: ":memory:",
});

const { loadConfig } = await import("../src/config.ts");
const { Store } = await import("../src/db.ts");
const { Engine } = await import("../src/engine.ts");
const { createApp } = await import("../src/server.ts");

const config = loadConfig();
const conn = new Connection(rpc.url, "confirmed");
const store = new Store(":memory:");
const stopEngine = new Engine(conn, store, config).start(1_000);
const server = createApp(store, config).listen(3100);
const api = "http://localhost:3100/api";

const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(9);
const balanceOf = async (k: { toBase58(): string } | string) =>
  conn.getBalance(typeof k === "string" ? new (await import("@solana/web3.js")).PublicKey(k) : (k as never));

// Préparation : le pool a une petite réserve, le trader a 3 SOL
await conn.requestAirdrop(pool.publicKey, 0.01 * LAMPORTS_PER_SOL);
const trader = Keypair.generate();
await conn.requestAirdrop(trader.publicKey, 3 * LAMPORTS_PER_SOL);
const destinations = [1, 2, 3].map(() => Keypair.generate().publicKey.toBase58());

// 1. Création de l'ordre via l'API
const order = await (
  await fetch(`${api}/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinations }) })
).json();
console.log(`Ordre ${order.id} créé — adresse de dépôt ${order.depositAddress}`);

// 2. Le trader envoie 2 SOL à l'adresse de dépôt
const { blockhash } = await conn.getLatestBlockhash();
const depositTx = new Transaction({ feePayer: trader.publicKey, recentBlockhash: blockhash }).add(
  SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: new (await import("@solana/web3.js")).PublicKey(order.depositAddress), lamports: 2 * LAMPORTS_PER_SOL }),
);
depositTx.sign(trader);
console.log(`Dépôt de 2 SOL envoyé : ${await conn.sendRawTransaction(depositTx.serialize())}`);

// 3. Suivi jusqu'à la fin
const started = Date.now();
let last = "";
let state = order;
while (!["completed", "failed", "refunded", "flagged"].includes(state.status)) {
  await new Promise((r) => setTimeout(r, 500));
  state = await (await fetch(`${api}/orders/${order.id}`)).json();
  const line = `${state.status} ${state.payouts.map((p: { status: string }) => p.status).join(",")}`;
  if (line !== last) console.log(`  t+${((Date.now() - started) / 1000).toFixed(1)}s  ${line}`);
  last = line;
  if (Date.now() - started > 120_000) throw new Error("Timeout");
}

console.log(`\nStatut final : ${state.status}  |  reçu ${state.receivedSol} SOL  |  commission ${state.feeSol} SOL`);
console.log("Paiements :");
for (const p of state.payouts) console.log(`  ${p.to}  ${p.amountSol} SOL  (prévu ${p.scheduledAt.slice(11, 19)})  ${p.signature?.slice(0, 16)}…`);

console.log("\nSoldes on-chain :");
let total = 0;
for (const d of destinations) {
  const b = await balanceOf(d);
  total += b;
  console.log(`  destination ${d.slice(0, 8)}…  ${sol(b)} SOL`);
}
console.log(`  total destinations         ${sol(total)} SOL`);
console.log(`  trésorerie                 ${sol(await balanceOf(treasury.publicKey))} SOL`);
console.log(`  pool (réserve 0.01)        ${sol(await balanceOf(pool.publicKey))} SOL`);
console.log(`  adresse de dépôt           ${sol(await balanceOf(order.depositAddress))} SOL`);
console.log(`  trader (3 − 2 − frais)     ${sol(await balanceOf(trader.publicKey))} SOL`);

// L'adresse de dépôt ne doit jamais payer directement une destination
const depositSigs = await conn.getSignaturesForAddress(new (await import("@solana/web3.js")).PublicKey(order.depositAddress));
const touched = new Set<string>();
for (const s of depositSigs) {
  const tx = await conn.getParsedTransaction(s.signature);
  tx?.transaction.message.accountKeys.forEach((k) => touched.add(k.pubkey.toBase58()));
}
const leaked = destinations.filter((d) => touched.has(d));
console.log(`\nLien direct dépôt → destination visible on-chain : ${leaked.length ? "OUI ⚠️" : "non ✓"}`);

stopEngine();
server.close();
rpc.close();
process.exit(state.status === "completed" && leaked.length === 0 ? 0 : 1);
