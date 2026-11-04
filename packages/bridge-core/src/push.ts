import { redactLogText } from '@nienie/agent-events';
import type {
  CanonicalAgentEvent,
  DevicePlatform,
  PushProvider,
} from '@nienie/protocol';

export type PushRegistration = {
  deviceId: string;
  platform: DevicePlatform;
  provider: PushProvider;
  pushToken: string;
};

export type PushNotificationMessage = {
  deviceId: string;
  platform: DevicePlatform;
  provider: PushProvider;
  pushToken: string;
  sessionId: string;
  title: string;
  body: string;
};

export type PushNotificationRouterOptions = {
  sender?: ((notification: PushNotificationMessage) => Promise<void>) | undefined;
};

export class PushNotificationRouter {
  private readonly registrations = new Map<string, PushRegistration>();
  private readonly sender: (notification: PushNotificationMessage) => Promise<void>;

  constructor(options: PushNotificationRouterOptions = {}) {
    this.sender = options.sender ?? (async () => {});
  }

  registerDevice(registration: PushRegistration): void {
    this.registrations.set(registration.deviceId, registration);
  }

  unregisterDevice(deviceId: string): void {
    this.registrations.delete(deviceId);
  }

  async notifyEvent(event: CanonicalAgentEvent): Promise<void> {
    if (this.registrations.size === 0) return;

    let title: string | undefined;
    let rawBody: string | undefined;

    if (event.type === 'status' && event.payload.status === 'waiting') {
      title = 'Nienie Permission Needed';
      rawBody =
        typeof event.payload.detail === 'string'
          ? event.payload.detail
          : 'Agent is waiting for approval';
    } else if (event.type === 'error') {
      title = 'Nienie Agent Error';
      rawBody =
        typeof event.payload.message === 'string'
          ? event.payload.message
          : 'Agent execution failed';
    }

    if (!title || !rawBody) return;

    const sanitizedBody = redactLogText(rawBody);
    await Promise.all(
      [...this.registrations.values()].map((reg) =>
        this.sender({
          deviceId: reg.deviceId,
          platform: reg.platform,
          provider: reg.provider,
          pushToken: reg.pushToken,
          sessionId: event.sessionId,
          title,
          body: sanitizedBody,
        }),
      ),
    );
  }
}
