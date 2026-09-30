/**
 * Mini-nœud Solana local pour tester sans devnet : un serveur JSON-RPC qui expose, au-dessus de LiteSVM
 * (la machine virtuelle Solana en mémoire), les méthodes RPC utilisées par l'app.
 *
 *   npm run local-validator            # écoute sur http://localhost:8899
 *   SOLANA_RPC_URL=http://localhost:8899 npm run dev
 *
 * Les transactions sont réellement exécutées (signatures, soldes, frais de 5000 lamports) ;
 * seuls l'historique et le "parsing" des transferts sont reconstitués par ce script.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { LAMPORTS_PER_SOL, SystemInstruction, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";

interface TxRecord {
  signature: string;
  slot: number;
  tx: Transaction;
  fee: number;
  pre: number[];
  post: number[];
  blockTime: number;
}

export function startLocalValidator(port = 8899) {
  const svm = new LiteSVM();
  const txs = new Map<string, TxRecord>();
  const byAddress = new Map<string, string[]>();
  let slot = 1;

  const balance = (address: string) => Number(svm.getBalance(address as never) ?? 0n);
  const ctx = () => ({ context: { slot } });

  function execute(raw: Buffer): string {
    const tx = Transaction.from(raw);
    const keys = tx.compileMessage().accountKeys.map((k) => k.toBase58());
    const pre = keys.map(balance);
    const result = (svm as unknown as { inner: { sendLegacyTransaction(raw: Buffer): unknown } }).inner.sendLegacyTransaction(raw);
    if (result instanceof FailedTransactionMetadata) {
      throw Object.assign(new Error(`Transaction simulation failed: ${result.toString()}`), { code: -32002 });
    }
    const signature = bs58.encode(tx.signature!);
    slot += 1;
    txs.set(signature, { signature, slot, tx, fee: 5000, pre, post: keys.map(balance), blockTime: Math.floor(Date.now() / 1000) });
    for (const key of new Set(keys)) byAddress.set(key, [signature, ...(byAddress.get(key) ?? [])]);
    return signature;
  }

  function parsedInstruction(ix: Transaction["instructions"][number]) {
    if (!ix.programId.equals(SystemProgram.programId)) {
      return { programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => k.pubkey.toBase58()), data: bs58.encode(ix.data) };
    }
    const { fromPubkey, toPubkey, lamports } = SystemInstruction.decodeTransfer(ix);
    return {
      program: "system",
      programId: SystemProgram.programId.toBase58(),
      parsed: { type: "transfer", info: { source: fromPubkey.toBase58(), destination: toPubkey.toBase58(), lamports: Number(lamports) } },
    };
  }

  const methods: Record<string, (params: any[]) => unknown> = {
    getHealth: () => "ok",
    getVersion: () => ({ "solana-core": "litesvm-local", "feature-set": 0 }),
    getSlot: () => slot,
    getBlockHeight: () => slot,
    getBalance: ([address]) => ({ ...ctx(), value: balance(address) }),
    getMinimumBalanceForRentExemption: ([size]) => Number(svm.minimumBalanceForRentExemption(BigInt(size ?? 0))),
    getLatestBlockhash: () => ({ ...ctx(), value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: slot + 150 } }),
    sendTransaction: ([data, opts]) => execute(opts?.encoding === "base64" ? Buffer.from(data, "base64") : Buffer.from(bs58.decode(data))),
    requestAirdrop: ([address, lamports]) => {
      svm.airdrop(address, BigInt(lamports) as never);
      return bs58.encode(Buffer.from(Array.from({ length: 64 }, () => Math.floor(Math.random() * 256))));
    },
    getSignatureStatuses: ([sigs]) => ({
      ...ctx(),
      value: (sigs as string[]).map((s) => {
        const t = txs.get(s);
        return t ? { slot: t.slot, confirmations: null, err: null, confirmationStatus: "finalized" } : null;
      }),
    }),
    getSignaturesForAddress: ([address, opts]) =>
      (byAddress.get(address) ?? []).slice(0, opts?.limit ?? 1000).map((s) => {
        const t = txs.get(s)!;
        return { signature: s, slot: t.slot, err: null, memo: null, blockTime: t.blockTime, confirmationStatus: "finalized" };
      }),
    getTransaction: ([signature]) => {
      const t = txs.get(signature);
      if (!t) return null;
      const message = t.tx.compileMessage();
      return {
        slot: t.slot,
        blockTime: t.blockTime,
        transaction: {
          signatures: t.tx.signatures.map((s) => bs58.encode(s.signature!)),
          message: {
            accountKeys: message.accountKeys.map((k, i) => ({
              pubkey: k.toBase58(),
              signer: message.isAccountSigner(i),
              writable: message.isAccountWritable(i),
              source: "transaction",
            })),
            instructions: t.tx.instructions.map(parsedInstruction),
            recentBlockhash: message.recentBlockhash,
          },
        },
        meta: { err: null, fee: t.fee, preBalances: t.pre, postBalances: t.post, innerInstructions: [], logMessages: [] },
      };
    },
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const handle = (call: { id: unknown; method: string; params?: any[] }) => {
        const fn = methods[call.method];
        if (!fn) return { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: `Méthode non supportée : ${call.method}` } };
        try {
          return { jsonrpc: "2.0", id: call.id, result: fn(call.params ?? []) };
        } catch (err) {
          const e = err as Error & { code?: number };
          return { jsonrpc: "2.0", id: call.id, error: { code: e.code ?? -32603, message: e.message } };
        }
      };
      const parsed = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(handle) : handle(parsed)));
    });
  });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(port, () => resolve({ url: `http://localhost:${port}`, close: () => server.close() })),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startLocalValidator(Number(process.env.LOCAL_RPC_PORT ?? 8899));
  console.log(`Nœud Solana local (LiteSVM) sur ${url} — airdrop : 1 SOL = ${LAMPORTS_PER_SOL} lamports`);
}
