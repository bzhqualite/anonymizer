import { randomInt } from "node:crypto";

/**
 * Découpe `total` lamports en `parts` montants aléatoires dont la somme vaut exactement `total`,
 * chacun étant >= `minPart`. Utilise un RNG cryptographique.
 */
export function randomSplit(total: bigint, parts: number, minPart: bigint): bigint[] {
  if (parts < 1) throw new Error("parts doit être >= 1");
  const floor = minPart * BigInt(parts);
  if (total < floor) throw new Error("Montant trop faible pour ce nombre de destinations");

  const spread = total - floor;
  const weights = Array.from({ length: parts }, () => BigInt(randomInt(1, 2 ** 32)));
  const sum = weights.reduce((a, b) => a + b, 0n);
  const amounts = weights.map((w) => minPart + (spread * w) / sum);

  // Le reste de la division entière est attribué à une part au hasard.
  const remainder = total - amounts.reduce((a, b) => a + b, 0n);
  amounts[randomInt(0, parts)] += remainder;
  return amounts;
}

/** Délai aléatoire uniforme dans [0, maxMs]. */
export function randomDelay(maxMs: number): number {
  return maxMs <= 0 ? 0 : randomInt(0, Math.floor(maxMs) + 1);
}
