import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  DEFAULT_RELAY_URL,
  encodePairingQrPayload,
  PROTOCOL_VERSION,
  resolveRelayUrl,
  type DevicePlatform,
  type PairedDevice,
  type PairingQrPayload,
} from '@nienie/protocol';

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;

export type PairingManagerOptions = {
  machineId?: string | undefined;
  relayUrl?: string | undefined;
  ttlMs?: number | undefined;
  now?: (() => Date) | undefined;
};

export type PairingChallenge = {
  pairingCode: string;
  expiresAt: string;
  qrPayload: PairingQrPayload;
  qrUri: string;
};

export type ConfirmPairingInput = {
  pairingCode: string;
  deviceName: string;
  platform?: DevicePlatform | undefined;
};

export type ConfirmPairingResult = {
  deviceId: string;
  deviceToken: string;
  machineId: string;
  pairedAt: string;
  device: PairedDevice;
};

type PendingPairingCode = {
  code: string;
  expiresAtMs: number;
};

type StoredDeviceRecord = PairedDevice & {
  tokenHash: string;
};

export class PairingManager {
  readonly machineId: string;
  private readonly relayUrl: string;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  private readonly pendingCodes = new Map<string, PendingPairingCode>();
  private readonly devices = new Map<string, StoredDeviceRecord>();
  private readonly tokenHashToDeviceId = new Map<string, string>();
  private readonly revokeListeners = new Set<(deviceId: string) => void>();

  constructor(options: PairingManagerOptions = {}) {
    this.machineId = options.machineId ?? 'machine_local';
    this.relayUrl = resolveRelayUrl(options.relayUrl ?? DEFAULT_RELAY_URL);
    this.ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  createPairingCode(input: { wsUrl: string; relayUrl?: string | undefined }): PairingChallenge {
    this.pruneExpiredCodes();

    let code = String(randomInt(100_000, 1_000_000));
    while (this.pendingCodes.has(code)) {
      code = String(randomInt(100_000, 1_000_000));
    }

    const expiresAtMs = this.now().getTime() + this.ttlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    this.pendingCodes.set(code, { code, expiresAtMs });

    const qrPayload: PairingQrPayload = {
      version: PROTOCOL_VERSION,
      machineId: this.machineId,
      wsUrl: input.wsUrl,
      relayUrl: resolveRelayUrl(input.relayUrl ?? this.relayUrl),
      pairingCode: code,
      expiresAt,
    };

    return {
      pairingCode: code,
      expiresAt,
      qrPayload,
      qrUri: encodePairingQrPayload(qrPayload),
    };
  }

  confirmPairing(input: ConfirmPairingInput): ConfirmPairingResult | undefined {
    this.pruneExpiredCodes();

    const code = input.pairingCode.trim();
    const pending = this.pendingCodes.get(code);
    if (!pending) {
      return undefined;
    }

    // Strictly one-time use: consume immediately
    this.pendingCodes.delete(code);

    if (pending.expiresAtMs <= this.now().getTime()) {
      return undefined;
    }

    const deviceId = `dev_${randomUUID()}`;
    const deviceToken = `ntk_${randomBytes(24).toString('hex')}`;
    const tokenHash = hashToken(deviceToken);
    const nowIso = this.now().toISOString();

    const record: StoredDeviceRecord = {
      deviceId,
      deviceName: input.deviceName.trim() || 'Mobile Device',
      platform: input.platform ?? 'unknown',
      pairedAt: nowIso,
      lastSeenAt: nowIso,
      tokenHash,
    };

    this.devices.set(deviceId, record);
    this.tokenHashToDeviceId.set(tokenHash, deviceId);

    return {
      deviceId,
      deviceToken,
      machineId: this.machineId,
      pairedAt: nowIso,
      device: toPublicDevice(record),
    };
  }

  verifyToken(deviceToken: string): PairedDevice | undefined {
    const trimmed = deviceToken.trim();
    if (!trimmed) return undefined;

    const tokenHash = hashToken(trimmed);
    const deviceId = this.tokenHashToDeviceId.get(tokenHash);
    if (!deviceId) return undefined;

    const record = this.devices.get(deviceId);
    if (!record || record.revokedAt !== undefined) {
      return undefined;
    }

    record.lastSeenAt = this.now().toISOString();
    return toPublicDevice(record);
  }

  isDeviceActive(deviceId: string): boolean {
    const record = this.devices.get(deviceId);
    return Boolean(record && record.revokedAt === undefined);
  }

  revokeDevice(deviceId: string): boolean {
    const record = this.devices.get(deviceId);
    if (!record || record.revokedAt !== undefined) {
      return false;
    }

    record.revokedAt = this.now().toISOString();
    this.tokenHashToDeviceId.delete(record.tokenHash);
    for (const listener of this.revokeListeners) {
      listener(deviceId);
    }
    return true;
  }

  listDevices(): PairedDevice[] {
    return [...this.devices.values()].map(toPublicDevice);
  }

  onDeviceRevoked(listener: (deviceId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  private pruneExpiredCodes(): void {
    const nowMs = this.now().getTime();
    for (const [code, entry] of this.pendingCodes.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        this.pendingCodes.delete(code);
      }
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toPublicDevice(record: StoredDeviceRecord): PairedDevice {
  return {
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    platform: record.platform,
    pairedAt: record.pairedAt,
    lastSeenAt: record.lastSeenAt,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
  };
}
