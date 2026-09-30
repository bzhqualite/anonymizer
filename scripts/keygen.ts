import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const pool = Keypair.generate();
console.log(`MASTER_KEY=${randomBytes(32).toString("hex")}`);
console.log(`POOL_SECRET_KEY=${bs58.encode(pool.secretKey)}`);
console.log(`# Adresse publique du pool : ${pool.publicKey.toBase58()}`);
