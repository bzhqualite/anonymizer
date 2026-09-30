import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type ParsedInstruction } from "@solana/web3.js";
import bs58 from "bs58";

export function isValidAddress(address: string): boolean {
  try {
    const key = new PublicKey(address);
    return !key.equals(SystemProgram.programId) && PublicKey.isOnCurve(key.toBytes());
  } catch {
    return false;
  }
}

export async function getFinalizedBalance(conn: Connection, address: string): Promise<bigint> {
  return BigInt(await conn.getBalance(new PublicKey(address), "finalized"));
}

/** Retrouve les adresses ayant envoyé des SOL vers `address` (transferts système finalisés). */
export async function findSenders(conn: Connection, address: string): Promise<string[]> {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(address), { limit: 20 }, "finalized");
  const senders: string[] = [];
  for (const { signature, err } of sigs.reverse()) {
    if (err) continue;
    const tx = await conn.getParsedTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    for (const ix of tx?.transaction.message.instructions ?? []) {
      const parsed = (ix as ParsedInstruction).parsed;
      if (ix.programId.equals(SystemProgram.programId) && parsed?.type === "transfer" && parsed.info.destination === address) {
        if (!senders.includes(parsed.info.source)) senders.push(parsed.info.source);
      }
    }
  }
  return senders;
}

/** Construit et signe un transfert sans l'envoyer : la signature est connue avant diffusion. */
export async function buildTransfer(conn: Connection, from: Keypair, to: string, lamports: bigint) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: from.publicKey, blockhash, lastValidBlockHeight }).add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new PublicKey(to), lamports }),
  );
  tx.sign(from);
  return {
    signature: bs58.encode(tx.signature!),
    raw: tx.serialize().toString("base64"),
    lastValidBlockHeight,
  };
}
