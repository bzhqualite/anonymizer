import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Chiffre les clés privées des adresses de dépôt avant stockage (AES-256-GCM).
export function encrypt(plain: Uint8Array, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decrypt(payload: string, key: Buffer): Uint8Array {
  const buf = Buffer.from(payload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return new Uint8Array(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]));
}
