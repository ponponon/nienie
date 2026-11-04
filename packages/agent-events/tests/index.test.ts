import { describe, expect, it } from 'vitest';
import {
  createAgentInfo,
  createCanonicalEvent,
  redactSensitiveData,
  truncateOutput,
} from '../src/index.js';

describe('agent event contracts', () => {
  it('creates stable agent metadata from an adapter including optional version', () => {
    const info = createAgentInfo(
      {
        id: 'opencode',
        name: 'OpenCode',
        capabilities: {
          streaming: true,
          thinking: true,
          toolCalls: true,
          fileChanges: true,
          permissionRequests: true,
          modelSwitch: true,
          sessionResume: true,
          cancel: true,
        },
      },
      true,
      '0.15.2',
    );

    expect(info).toMatchObject({ id: 'opencode', available: true, version: '0.15.2' });
  });

  it('builds a canonical agent event envelope with version 1', () => {
    const event = createCanonicalEvent({
      eventId: 'evt_1',
      machineId: 'machine_local',
      agentId: 'opencode',
      sessionId: 'ses_1',
      sequence: 1,
      timestamp: '2026-11-04T00:00:00.000Z',
      type: 'text_delta',
      payload: { delta: 'Hello' },
    });

    expect(event).toEqual({
      version: 1,
      eventId: 'evt_1',
      machineId: 'machine_local',
      agentId: 'opencode',
      sessionId: 'ses_1',
      sequence: 1,
      timestamp: '2026-11-04T00:00:00.000Z',
      type: 'text_delta',
      payload: { delta: 'Hello' },
    });
  });

  it('redacts sensitive credentials from nested tool inputs and payloads', () => {
    const sanitized = redactSensitiveData({
      command: 'npm test',
      env: {
        OPENAI_API_KEY: 'sk-secret-123',
        OPENCTRLC_SERVER_PASSWORD: 'pw-123',
        NODE_ENV: 'test',
      },
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });

    expect(sanitized).toEqual({
      command: 'npm test',
      env: {
        OPENAI_API_KEY: '[REDACTED]',
        OPENCTRLC_SERVER_PASSWORD: '[REDACTED]',
        NODE_ENV: 'test',
      },
      headers: {
        Authorization: '[REDACTED]',
      },
    });
  });

  it('truncates oversized tool output while preserving small output', () => {
    expect(truncateOutput('short output', 20)).toEqual({
      content: 'short output',
      truncated: false,
    });

    const longText = 'abcdefghij1234567890EXTRA';
    expect(truncateOutput(longText, 20)).toEqual({
      content: 'abcdefghij1234567890\n...[truncated 5 chars]',
      truncated: true,
    });
  });
});
