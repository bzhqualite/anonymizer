const { Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } = solanaWeb3;
const $ = (id) => document.getElementById(id);

const STATUS_LABELS = {
  awaiting_deposit: "En attente du dépôt",
  expired: "Expiré (aucun dépôt reçu)",
  sweeping: "Dépôt reçu, traitement…",
  processing: "Paiements en cours",
  completed: "Terminé",
  refunding: "Remboursement en cours",
  refunded: "Remboursé",
  flagged: "En revue manuelle",
  failed: "Échec — contactez le support",
};

const PAYOUT_LABELS = { pending: "programmé", sent: "envoyé", confirmed: "confirmé", failed: "échec" };

let config;
let order;

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

function addDestination(value = "") {
  if ($("destinations").children.length >= config.maxDestinations) return;
  const row = document.createElement("div");
  row.className = "dest";
  row.innerHTML = `<input placeholder="Adresse Solana" /><button type="button" class="ghost">✕</button>`;
  row.querySelector("input").value = value;
  row.querySelector("button").onclick = () => row.remove();
  $("destinations").append(row);
}

async function createOrder() {
  $("create-error").textContent = "";
  const destinations = [...$("destinations").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  try {
    order = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({ destinations, refundAddress: $("refund").value.trim() || undefined }),
    });
  } catch (err) {
    $("create-error").textContent = err.message;
    return;
  }
  localStorage.setItem("orderId", order.id);
  showOrder();
}

async function payWithPhantom() {
  $("pay-error").textContent = "";
  const provider = window.phantom?.solana ?? window.solana;
  if (!provider?.isPhantom) {
    $("pay-error").textContent = "Phantom non détecté. Envoyez les SOL manuellement à l'adresse ci-dessus.";
    return;
  }
  const sol = Number($("amount").value);
  if (!(sol >= config.minDepositSol && sol <= config.maxDepositSol)) {
    $("pay-error").textContent = `Le montant doit être entre ${config.minDepositSol} et ${config.maxDepositSol} SOL`;
    return;
  }
  try {
    $("pay").disabled = true;
    const { publicKey } = await provider.connect();
    const conn = new Connection(config.rpcUrl, "confirmed");
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: new PublicKey(order.depositAddress),
        lamports: Math.round(sol * LAMPORTS_PER_SOL),
      }),
    );
    const { signature } = await provider.signAndSendTransaction(tx);
    $("pay-error").textContent = "";
    $("pay").textContent = "Envoyé ✓";
    console.log("Dépôt envoyé", signature);
  } catch (err) {
    $("pay").disabled = false;
    $("pay-error").textContent = err.message ?? String(err);
  }
}

function renderOrder() {
  $("status").textContent = STATUS_LABELS[order.status] ?? order.status;
  $("order-id").textContent = `Ordre ${order.id}` + (order.error ? ` — ${order.error}` : "");
  $("step-deposit").classList.toggle("hidden", order.status !== "awaiting_deposit");
  $("payouts").innerHTML = order.payouts
    .map((p) => {
      const link = p.signature ? `<a href="https://solscan.io/tx/${p.signature}${cluster()}" target="_blank">✓</a>` : "";
      return `<tr><td class="addr">${p.kind === "refund" ? "↩ " : ""}${p.to}</td><td>${p.amountSol} SOL</td>
        <td class="${p.status}">${PAYOUT_LABELS[p.status] ?? p.status} ${link}</td><td>${new Date(p.scheduledAt).toLocaleTimeString()}</td></tr>`;
    })
    .join("");
}

function formatDelay(minutes) {
  return minutes >= 1 ? `${Math.round(minutes)} min` : `${Math.round(minutes * 60)} s`;
}

function cluster() {
  return config.rpcUrl.includes("devnet") ? "?cluster=devnet" : "";
}

function showOrder() {
  $("step-create").classList.add("hidden");
  $("step-status").classList.remove("hidden");
  $("deposit-address").textContent = order.depositAddress;
  $("deposit-limits").textContent =
    `Entre ${config.minDepositSol} et ${config.maxDepositSol} SOL, en une seule transaction, avant ${new Date(order.expiresAt).toLocaleTimeString()}.`;
  renderOrder();
  const poll = setInterval(async () => {
    order = await api(`/api/orders/${order.id}`);
    renderOrder();
    if (["completed", "refunded", "expired", "failed"].includes(order.status)) clearInterval(poll);
  }, 5000);
}

async function init() {
  config = await api("/api/config");
  $("terms").textContent =
    `Commission ${config.feePercent} % · jusqu'à ${config.maxDestinations} wallets · paiements étalés sur ${formatDelay(config.maxPayoutDelayMinutes)} max.`;
  addDestination();
  addDestination();
  $("add-dest").onclick = () => addDestination();
  $("create").onclick = createOrder;
  $("pay").onclick = payWithPhantom;
  $("copy").onclick = () => navigator.clipboard.writeText(order.depositAddress);

  const saved = localStorage.getItem("orderId");
  if (saved) {
    try {
      order = await api(`/api/orders/${saved}`);
      if (!["completed", "refunded", "expired", "failed"].includes(order.status)) return showOrder();
    } catch {}
    localStorage.removeItem("orderId");
  }
}

init();
