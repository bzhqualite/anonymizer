// Frais réseau d'une transaction simple à une signature (sans priority fee).
export const TX_FEE = 5_000n;

// Montant minimal par destination : couvre le minimum "rent-exempt" d'un compte vide (890 880 lamports).
export const MIN_PAYOUT = 1_000_000n;

/** Commission du service, arrondie à l'inférieur. */
export function commission(amount: bigint, feeBps: bigint): bigint {
  return (amount * feeBps) / 10_000n;
}

/**
 * Montant redistribuable après commission et frais réseau. On réserve :
 * - 1 tx pour transférer le dépôt vers le pool (payée par l'adresse de dépôt)
 * - 1 tx par destination (payées par le pool)
 * - 1 tx pour reverser la commission à la trésorerie (payée par le pool)
 */
export function distributable(amount: bigint, feeBps: bigint, destinations: number): bigint {
  return amount - commission(amount, feeBps) - TX_FEE * BigInt(destinations + 2);
}
