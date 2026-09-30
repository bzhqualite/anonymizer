import assert from "node:assert/strict";
import { test } from "node:test";
import { commission, distributable, TX_FEE } from "../src/fees.ts";
import { randomSplit } from "../src/split.ts";
import { decrypt, encrypt } from "../src/crypto.ts";
import { randomBytes } from "node:crypto";

test("randomSplit conserve le total et respecte le minimum", () => {
  for (let i = 0; i < 500; i++) {
    const parts = 1 + (i % 5);
    const total = 2_000_000_000n + BigInt(i * 7919);
    const amounts = randomSplit(total, parts, 1_000_000n);
    assert.equal(amounts.length, parts);
    assert.equal(amounts.reduce((a, b) => a + b, 0n), total);
    for (const a of amounts) assert.ok(a >= 1_000_000n);
  }
});

test("randomSplit produit des montants différents", () => {
  const a = randomSplit(2_000_000_000n, 3, 1_000_000n);
  const b = randomSplit(2_000_000_000n, 3, 1_000_000n);
  assert.notDeepEqual(a, b);
});

test("randomSplit refuse un montant trop faible", () => {
  assert.throws(() => randomSplit(2_000_000n, 3, 1_000_000n));
});

test("commission et montant redistribuable", () => {
  assert.equal(commission(2_000_000_000n, 100n), 20_000_000n);
  assert.equal(distributable(2_000_000_000n, 100n, 3), 2_000_000_000n - 20_000_000n - 5n * TX_FEE);
});

test("chiffrement des clés de dépôt", () => {
  const key = randomBytes(32);
  const secret = randomBytes(64);
  assert.deepEqual(Buffer.from(decrypt(encrypt(secret, key), key)), secret);
  assert.throws(() => decrypt(encrypt(secret, key), randomBytes(32)));
});
