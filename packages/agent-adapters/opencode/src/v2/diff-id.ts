import { createHash } from 'node:crypto';

export type DiffIdInput = {
  sessionId: string;
  fromMessageId: string;
  toMessageId: string;
  file: string;
  patch: string;
};

function requireResolvedId(name: string, value: string | undefined | null): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`diffId input ${name} must be a resolved non-empty string`);
  }
  return value;
}

export function deriveDiffId(input: DiffIdInput): string {
  const sessionId = requireResolvedId('sessionId', input.sessionId);
  const fromMessageId = requireResolvedId('fromMessageId', input.fromMessageId);
  const toMessageId = requireResolvedId('toMessageId', input.toMessageId);
  const file = requireResolvedId('file', input.file);
  const patch = input.patch;
  if (typeof patch !== 'string') {
    throw new Error('diffId input patch must be a string (empty patch is allowed)');
  }
  const canonical = JSON.stringify(['diff:v1', sessionId, fromMessageId, toMessageId, file, patch]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
