export const OPENCODE_HEALTH_FIXTURE = {
  healthy: true,
  version: '0.15.2',
};

export const OPENCODE_SESSIONS_FIXTURE = [
  {
    id: 'ses_alpha',
    projectID: 'proj_1',
    directory: '/workspace/nienie',
    title: 'Implement OpenCode adapter',
    version: '0.15.2',
    time: {
      created: 1762214400000,
      updated: 1762214460000,
    },
  },
  {
    id: 'ses_beta',
    projectID: 'proj_1',
    directory: '/workspace/nienie',
    title: 'Fix flaky test',
    version: '0.15.2',
    time: {
      created: 1762210800000,
      updated: 1762210900000,
    },
  },
];

export const OPENCODE_SESSION_STATUS_FIXTURE = {
  ses_alpha: { type: 'busy' as const },
  ses_beta: { type: 'idle' as const },
};

export const OPENCODE_STREAM_LIFECYCLE_FIXTURE = [
  {
    id: 'evt_conn_1',
    type: 'server.connected',
    properties: {},
  },
  {
    id: 'evt_status_busy',
    type: 'session.status',
    properties: {
      sessionID: 'ses_alpha',
      status: { type: 'busy' },
    },
  },
  {
    id: 'evt_user_msg',
    type: 'message.updated',
    properties: {
      sessionID: 'ses_alpha',
      info: {
        id: 'msg_user_1',
        sessionID: 'ses_alpha',
        role: 'user',
        time: { created: 1762214401000 },
        agent: 'code',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      },
    },
  },
  {
    id: 'evt_user_part',
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_alpha',
      part: {
        id: 'part_user_1',
        sessionID: 'ses_alpha',
        messageID: 'msg_user_1',
        type: 'text',
        text: '请运行测试并修复错误',
      },
    },
  },
  {
    id: 'evt_asst_msg',
    type: 'message.updated',
    properties: {
      sessionID: 'ses_alpha',
      info: {
        id: 'msg_asst_1',
        sessionID: 'ses_alpha',
        role: 'assistant',
        parentID: 'msg_user_1',
        modelID: 'claude-sonnet-4',
        providerID: 'anthropic',
        mode: 'code',
        path: { cwd: '/workspace/nienie', root: '/workspace/nienie' },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: { created: 1762214402000 },
      },
    },
  },
  {
    id: 'evt_reasoning_1',
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_alpha',
      part: {
        id: 'part_reason_1',
        sessionID: 'ses_alpha',
        messageID: 'msg_asst_1',
        type: 'reasoning',
        text: '先检查 package.json 中的测试脚本',
        time: { start: 1762214402100 },
      },
      delta: '先检查 package.json 中的测试脚本',
    },
  },
  {
    id: 'evt_text_delta_1',
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses_alpha',
      messageID: 'msg_asst_1',
      partID: 'part_text_1',
      field: 'text',
      delta: '我将运行测试',
    },
  },
  {
    id: 'evt_text_delta_2',
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses_alpha',
      messageID: 'msg_asst_1',
      partID: 'part_text_1',
      field: 'text',
      delta: '来验证当前状态。',
    },
  },
  {
    id: 'evt_text_snapshot',
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_alpha',
      part: {
        id: 'part_text_1',
        sessionID: 'ses_alpha',
        messageID: 'msg_asst_1',
        type: 'text',
        text: '我将运行测试来验证当前状态。',
        time: { start: 1762214402500, end: 1762214403000 },
      },
    },
  },
  {
    id: 'evt_tool_running',
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_alpha',
      part: {
        id: 'part_tool_1',
        sessionID: 'ses_alpha',
        messageID: 'msg_asst_1',
        type: 'tool',
        callID: 'call_bash_01',
        tool: 'bash',
        state: {
          status: 'running',
          input: {
            command: 'pnpm test',
            apiKey: 'sk-should-not-leak',
          },
          title: 'Run workspace tests',
          time: { start: 1762214403100 },
        },
      },
    },
  },
  {
    id: 'evt_tool_completed',
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_alpha',
      part: {
        id: 'part_tool_1',
        sessionID: 'ses_alpha',
        messageID: 'msg_asst_1',
        type: 'tool',
        callID: 'call_bash_01',
        tool: 'bash',
        state: {
          status: 'completed',
          input: {
            command: 'pnpm test',
          },
          output: 'Test Files 5 passed (5)',
          title: 'Run workspace tests',
          metadata: { exitCode: 0 },
          time: { start: 1762214403100, end: 1762214404500 },
        },
      },
    },
  },
  {
    id: 'evt_perm_asked',
    type: 'permission.asked',
    properties: {
      id: 'perm_1',
      sessionID: 'ses_alpha',
      permission: 'bash',
      patterns: ['rm -rf dist'],
      metadata: {},
      always: [],
      tool: {
        messageID: 'msg_asst_1',
        callID: 'call_bash_02',
      },
    },
  },
  {
    id: 'evt_step_finish',
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_alpha',
      part: {
        id: 'part_step_finish_1',
        sessionID: 'ses_alpha',
        messageID: 'msg_asst_1',
        type: 'step-finish',
        reason: 'stop',
        cost: 0.0142,
        tokens: {
          input: 1500,
          output: 420,
          reasoning: 120,
          cache: { read: 300, write: 0 },
        },
      },
    },
  },
  {
    id: 'evt_session_err',
    type: 'session.error',
    properties: {
      sessionID: 'ses_alpha',
      error: {
        name: 'APIError',
        data: {
          message: 'Rate limit exceeded',
          statusCode: 429,
          isRetryable: true,
        },
      },
    },
  },
  {
    id: 'evt_session_idle',
    type: 'session.idle',
    properties: {
      sessionID: 'ses_alpha',
    },
  },
];
