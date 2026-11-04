import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type EncryptedRelayPayload = {
  alg: 'aes-256-gcm';
  iv: string;
  ciphertext: string;
  tag: string;
};

export function encryptRelayPayload(
  plaintext: string,
  sharedSecret: string,
): EncryptedRelayPayload {
  const key = deriveRelayKey(sharedSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    ciphertext: encrypted.toString('base64url'),
    tag: tag.toString('base64url'),
  };
}

export function decryptRelayPayload(
  box: EncryptedRelayPayload,
  sharedSecret: string,
): string {
  if (box.alg !== 'aes-256-gcm') {
    throw new Error(`Unsupported encryption algorithm: ${String(box.alg)}`);
  }
  const key = deriveRelayKey(sharedSecret);
  const iv = Buffer.from(box.iv, 'base64url');
  const ciphertext = Buffer.from(box.ciphertext, 'base64url');
  const tag = Buffer.from(box.tag, 'base64url');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

function deriveRelayKey(sharedSecret: string): Buffer {
  return createHash('sha256').update(`nienie-relay-v1:${sharedSecret}`).digest();
}
