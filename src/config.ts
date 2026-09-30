import { existsSync, readFileSync } from "node:fs";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

if (existsSync(".env")) process.loadEnvFile(".env");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Valeur invalide pour ${name} : ${raw}`);
  return value;
}

function sol(name: string, fallback: number): bigint {
  return BigInt(Math.round(num(name, fallback) * LAMPORTS_PER_SOL));
}

export function loadConfig() {
  const masterKey = Buffer.from(required("MASTER_KEY"), "hex");
  if (masterKey.length !== 32) throw new Error("MASTER_KEY doit faire 32 octets (64 caractères hex)");

  const pool = Keypair.fromSecretKey(bs58.decode(required("POOL_SECRET_KEY")));
  const treasury = process.env.TREASURY_ADDRESS ? new PublicKey(process.env.TREASURY_ADDRESS) : null;

  const feeBps = num("FEE_BPS", 100);
  if (feeBps >= 10_000) throw new Error("FEE_BPS doit être < 10000");

  return {
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    port: num("PORT", 3000),
    masterKey,
    pool,
    treasury,
    feeBps: BigInt(Math.floor(feeBps)),
    minDeposit: sol("MIN_DEPOSIT_SOL", 0.1),
    maxDeposit: sol("MAX_DEPOSIT_SOL", 100),
    maxDestinations: Math.floor(num("MAX_DESTINATIONS", 5)),
    orderTtlMs: num("ORDER_TTL_MINUTES", 60) * 60_000,
    maxPayoutDelayMs: num("MAX_PAYOUT_DELAY_MINUTES", 30) * 60_000,
    blocklist: loadBlocklist(process.env.BLOCKLIST_FILE ?? "blocklist.txt"),
    dbPath: process.env.DB_PATH ?? "data/anonymizer.db",
  };
}

function loadBlocklist(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

export type Config = ReturnType<typeof loadConfig>;
