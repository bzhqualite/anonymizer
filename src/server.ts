import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { LAMPORTS_PER_SOL, Keypair } from "@solana/web3.js";
import express from "express";
import type { Config } from "./config.ts";
import { encrypt } from "./crypto.ts";
import type { Store } from "./db.ts";
import { isValidAddress } from "./solana.ts";

const toSol = (lamports: bigint | null) => (lamports == null ? null : Number(lamports) / LAMPORTS_PER_SOL);

export function createApp(store: Store, config: Config) {
  const app = express();
  app.use(express.json({ limit: "10kb" }));
  app.use(express.static("public"));

  // web3.js côté navigateur, servi depuis node_modules (pas de CDN tiers)
  const web3Bundle = createRequire(import.meta.url).resolve("@solana/web3.js/lib/index.iife.min.js");
  app.get("/vendor/web3.js", (_req, res) => res.sendFile(web3Bundle));

  app.get("/api/config", (_req, res) => {
    res.json({
      rpcUrl: config.rpcUrl,
      feePercent: Number(config.feeBps) / 100,
      minDepositSol: toSol(config.minDeposit),
      maxDepositSol: toSol(config.maxDeposit),
      maxDestinations: config.maxDestinations,
      maxPayoutDelayMinutes: config.maxPayoutDelayMs / 60_000,
    });
  });

  app.post("/api/orders", (req, res) => {
    const { destinations, refundAddress } = req.body ?? {};
    if (!Array.isArray(destinations) || destinations.length < 1 || destinations.length > config.maxDestinations) {
      return res.status(400).json({ error: `Indiquez entre 1 et ${config.maxDestinations} wallets de destination` });
    }
    const clean = destinations.map((d: unknown) => String(d).trim());
    const invalid = clean.filter((d) => !isValidAddress(d));
    if (invalid.length) return res.status(400).json({ error: `Adresse(s) invalide(s) : ${invalid.join(", ")}` });
    if (new Set(clean).size !== clean.length) return res.status(400).json({ error: "Les destinations doivent être distinctes" });
    if (clean.includes(config.pool.publicKey.toBase58())) return res.status(400).json({ error: "Destination interdite" });
    if (clean.some((d) => config.blocklist.has(d))) return res.status(403).json({ error: "Destination refusée" });
    if (refundAddress != null && refundAddress !== "" && !isValidAddress(String(refundAddress))) {
      return res.status(400).json({ error: "Adresse de remboursement invalide" });
    }

    const deposit = Keypair.generate();
    const id = randomUUID();
    store.createOrder({
      id,
      deposit_address: deposit.publicKey.toBase58(),
      deposit_secret: encrypt(deposit.secretKey, config.masterKey),
      destinations: clean,
      refund_address: refundAddress ? String(refundAddress) : null,
      expires_at: Date.now() + config.orderTtlMs,
    });
    res.status(201).json(publicOrder(store, id));
  });

  app.get("/api/orders/:id", (req, res) => {
    const order = publicOrder(store, req.params.id);
    if (!order) return res.status(404).json({ error: "Ordre introuvable" });
    res.json(order);
  });

  return app;
}

function publicOrder(store: Store, id: string) {
  const order = store.getOrder(id);
  if (!order) return undefined;
  return {
    id: order.id,
    status: order.status,
    depositAddress: order.deposit_address,
    destinations: order.destinations,
    receivedSol: toSol(order.received),
    feeSol: toSol(order.fee),
    expiresAt: new Date(order.expires_at).toISOString(),
    error: order.status === "flagged" ? "Ordre en revue manuelle" : order.error,
    // Seuls les paiements vers l'utilisateur sont exposés (pas le transfert interne vers le pool)
    payouts: store
      .transfersForOrder(order.id)
      .filter((t) => t.kind === "payout" || t.kind === "refund")
      .map((t) => ({
        kind: t.kind,
        to: t.to_address,
        amountSol: toSol(t.lamports),
        status: t.status,
        scheduledAt: new Date(t.scheduled_at).toISOString(),
        signature: t.status === "confirmed" ? t.signature : null,
      })),
  };
}
