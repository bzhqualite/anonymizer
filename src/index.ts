import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { Engine } from "./engine.ts";
import { createApp } from "./server.ts";

const config = loadConfig();
const store = new Store(config.dbPath);
const conn = new Connection(config.rpcUrl, "confirmed");

new Engine(conn, store, config).start();
createApp(store, config).listen(config.port, () => {
  console.log(`Serveur démarré sur http://localhost:${config.port}`);
  console.log(`RPC : ${config.rpcUrl}`);
  console.log(`Pool : ${config.pool.publicKey.toBase58()}`);
});
