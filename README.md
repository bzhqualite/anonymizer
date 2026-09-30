# Solana Splitter — redistribution de SOL anti copy-trading

Un trader envoie des SOL au service, indique 1 à N wallets de destination, et le service
renvoie les fonds en **montants aléatoires**, **à des moments aléatoires**, **depuis un wallet pool
commun**, en prélevant une commission. Objectif : que les bots de copy-trading qui suivent le wallet
source ne puissent pas identifier facilement les nouveaux wallets de trading.

## Fonctionnement

```
wallet1 ──2 SOL──▶ adresse de dépôt unique ──sweep──▶ POOL ──x₁──▶ wallet A   (t + délai aléatoire)
                    (générée par ordre)                    ├──x₂──▶ wallet B   (t + délai aléatoire)
                                                           ├──x₃──▶ wallet C   (t + délai aléatoire)
                                                           └──commission──▶ trésorerie
```

1. `POST /api/orders` avec les destinations → le serveur génère une **adresse de dépôt unique**
   (clé privée chiffrée AES-256-GCM en base).
2. L'utilisateur envoie ses SOL (bouton Phantom ou envoi manuel).
3. Le worker détecte le dépôt (commitment `finalized`), identifie l'expéditeur, vérifie la liste de blocage
   et les limites, puis transfère le dépôt vers le **pool**.
4. Le montant net (dépôt − commission − frais réseau) est découpé en N parts aléatoires
   (RNG cryptographique, somme exacte au lamport près, minimum 0,001 SOL par part).
5. Chaque paiement part **du pool** avec un délai aléatoire (0 à `MAX_PAYOUT_DELAY_MINUTES`).
   La commission est reversée à `TREASURY_ADDRESS` après le dernier paiement.

Pourquoi un pool ? Si les paiements partaient directement de l'adresse de dépôt, n'importe qui
verrait `wallet1 → dépôt → A, B, C` : le lien serait immédiat. Le pool mélange les flux de tous les
utilisateurs.

**Exemple** : 2 SOL, commission 1 %, 3 destinations → 0,02 SOL de commission, 25 000 lamports de
frais réseau, 1,979975 SOL répartis par ex. en 0,412… / 1,203… / 0,364… SOL.

### Robustesse des paiements

Chaque transaction est signée puis **enregistrée en base avant diffusion** (signature, tx brute,
`lastValidBlockHeight`). Après un crash, le worker vérifie la signature au lieu de repayer ; il ne
reconstruit une transaction que lorsque le blockhash de la précédente a expiré. 5 tentatives max.

### Statuts d'un ordre

`awaiting_deposit` → `sweeping` → `processing` → `completed`
Cas particuliers : `expired` (pas de dépôt), `refunding`/`refunded` (montant hors limites),
`flagged` (adresse bloquée : fonds gelés, revue manuelle), `failed`.

## Installation

```bash
npm install
npm run keygen          # génère MASTER_KEY et POOL_SECRET_KEY
cp .env.example .env    # puis collez les valeurs générées
npm run dev             # http://localhost:3000
```

Sur devnet, alimentez le pool avec un peu de SOL (`solana airdrop 1 <adresse du pool> --url devnet`) :
il doit garder le minimum rent-exempt, et avance les frais réseau.

```bash
npm test        # tests unitaires + scénario complet sur une blockchain simulée
npm run typecheck
```

### Tester sans devnet : nœud Solana local

`scripts/local-validator.ts` expose un petit serveur JSON-RPC au-dessus de
[LiteSVM](https://github.com/LiteSVM/litesvm) (la machine virtuelle Solana en mémoire). Les
transactions sont réellement signées et exécutées, frais compris.

```bash
npm run e2e                 # scénario complet automatique : 2 SOL → 3 wallets, vérifie les soldes on-chain

# ou à la main, avec l'interface web :
npm run local-validator     # terminal 1 : http://localhost:8899
# dans .env : SOLANA_RPC_URL=http://localhost:8899
npm run dev                 # terminal 2
```

Sur le nœud local, alimentez les wallets avec `requestAirdrop` (par exemple via
`solana airdrop 1 <adresse> --url http://localhost:8899`). Attention : Phantom diffuse la
transaction sur le réseau choisi dans ses propres réglages, qui doit correspondre à `SOLANA_RPC_URL`.
Sur le nœud local, le plus simple est d'envoyer le dépôt avec `solana transfer`, et de tester
Phantom sur devnet.

## Structure

| Fichier | Rôle |
|---|---|
| `src/engine.ts` | Worker : détection des dépôts, sweep, découpage, paiements, remboursements |
| `src/split.ts` | Découpage aléatoire et délais |
| `src/fees.ts` | Commission et frais réseau |
| `src/solana.ts` | Accès RPC (solde, expéditeurs, construction des transferts) |
| `src/db.ts` | Stockage SQLite (`node:sqlite`) |
| `src/server.ts` | API REST + front statique |
| `public/` | Interface web (Phantom) |

## ⚠️ Avant la mise en production — à lire

**Réglementaire.** Recevoir des cryptos de tiers et les renvoyer contre commission est, en droit
français/européen, une activité de prestataire de services sur crypto-actifs (**CASP, règlement MiCA**,
agrément AMF) soumise à la **LCB-FT** (KYC, screening, déclarations Tracfin) et à la *travel rule*
(règlement UE 2023/1113). Les services de « mixing » sont particulièrement surveillés : Tornado Cash
a été sanctionné, et les fondateurs de Samourai Wallet ont été condamnés en 2025 pour transmission de
fonds sans licence. **Faites valider le modèle par un avocat spécialisé avant tout lancement public.**
Le code prévoit des points d'ancrage conformité (liste de blocage des expéditeurs et destinations, gel
des fonds suspects, limites min/max, journal complet des ordres), mais pas de KYC.

**Efficacité réelle.** L'anonymat dépend du volume du pool. Avec peu d'utilisateurs, une analyse
temps/montants (« 2 SOL entrent, ~1,98 SOL sortent dans les 30 min ») relie encore les wallets.
Plus les délais sont longs et le pool actif, meilleure est la protection.

**Sécurité.** Le pool est un hot wallet : limitez son solde, sortez régulièrement l'excédent vers
un cold wallet, protégez `MASTER_KEY` et `POOL_SECRET_KEY` (gestionnaire de secrets, pas de `.env`
en prod), utilisez un RPC privé, faites auditer le code. Le worker suppose **une seule instance**.

## Pistes d'évolution

- Admin : revue des ordres `flagged`, retrait de la trésorerie, statistiques
- Intégration d'un fournisseur KYT (Chainalysis, TRM, Elliptic) à la place du fichier de blocage
- Support des tokens SPL (USDC…)
- Priority fees dynamiques en période de congestion
- Notifications (webhook / Telegram) quand un ordre est terminé
