export const CODEX_JSONL_LIFECYCLE_FIXTURE = [
  {
    type: 'thread.started',
    thread_id: 'thread_codex_01',
  },
  {
    type: 'turn.started',
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_reason_1',
      type: 'reasoning',
      text: '先检查工作区目录与测试配置',
    },
  },
  {
    type: 'item.Started',
    item: {
      id: 'item_cmd_1',
      type: 'command_execution',
      command: 'pnpm test',
      status: 'in_progress',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_cmd_1',
      type: 'command_execution',
      command: 'pnpm test',
      aggregated_output: 'All tests passed',
      exit_code: 0,
      status: 'completed',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_patch_1',
      type: 'file_change',
      changes: [
        { path: 'src/index.ts', kind: 'update' },
        { path: 'tests/index.test.ts', kind: 'add' },
      ],
      status: 'completed',
    },
  },
  {
    type: 'item.updated',
    item: {
      id: 'item_msg_1',
      type: 'agent_message',
      text: '我已经完成了修复，',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_msg_1',
      type: 'agent_message',
      text: '我已经完成了修复，并且测试全部通过。',
    },
  },
  {
    type: 'turn.completed',
    usage: {
      input_tokens: 1800,
      cached_input_tokens: 400,
      output_tokens: 260,
    },
  },
];
