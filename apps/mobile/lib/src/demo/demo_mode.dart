import '../i18n/app_strings.dart';
import '../models/protocol_models.dart';
import '../state/mobile_bridge_client.dart';
import '../storage/credential_store.dart';
import '../transport/fake_bridge_transport.dart';

/// 商店截图与审核演示用的种子数据。
///
/// 只在 `flutter build ios --dart-define=NIE_DEMO=true` 时被 [main] 引用；
/// 正式构建里 `bool.fromEnvironment('NIE_DEMO')` 恒为 false，本文件不进入调用图，
/// 也就不会把 [FakeBridgeTransport] 打进发布包。
///
/// 数据是示例内容，但走的是真实 UI 与真实渲染管线——符合 App Store
/// 「截图必须来自真实 App 界面」的要求（示例数据属行业惯例）。
Future<MobileBridgeClient> createDemoClient({
  required DeviceCredentialStore credentialStore,
  AppLanguage language = AppLanguage.zh,
}) async {
  final transport = FakeBridgeTransport();
  // 种子内容跟随语言：美区商店截图用英文，中文用于本地预览与国内渠道物料。
  final en = language == AppLanguage.en;
  transport.snapshotResponse = {
    'schemaVersion': 1,
    'snapshotId': 'snap_demo',
    'sessionId': 'ses_alpha',
    'agentId': 'opencode',
    'streamEpoch': 'ep_demo',
    'watermark': 12,
    'capturedAt': DateTime.now().toIso8601String(),
    'complete': true,
    'hasMore': false,
    // totalParts 必须与 parts 数量严格相等（loadSessionSnapshot 白名单校验）
    'totalParts': 6,
    'parts': [
      _message('m1', 0, 'user', en
          ? 'Reconnect lost the session. Fix it.'
          : '断网恢复后会话没自动进入，帮我修掉。'),
      _message('m2', 1, 'assistant', en
          ? '`loadSavedPreferences(autoReconnect)` never restores `activeSessionId`. I will persist it and auto-reopen the session.'
          : '`loadSavedPreferences(autoReconnect)` 没恢复 `activeSessionId`，会话上下文丢失。我来补上持久化，重连后自动回原会话。'),
      _tool('pt1', 2, 't1', 'search', {'query': 'activeSessionId', 'path': 'lib/src/state'},
          'completed', '3 matches'),
      _tool('pt2', 3, 't2', 'edit',
          {'file': 'lib/src/state/mobile_bridge_client.dart', 'hunks': 2},
          'completed', '+18 -4'),
      _tool('pt3', 4, 't3', 'shell',
          {'command': 'flutter test test/mobile_app_test.dart'},
          'completed', 'All 116 tests passed'),
      _message('m3', 5, 'assistant', en
          ? 'Fixed — all 116 tests pass:\n1. Persist `activeSessionId` on `openSession`\n2. Auto-reopen after reconnect\n3. Keep context across disconnects'
          : '修好了，116 项测试全过：\n1. `activeSessionId` 随 `openSession` 持久化\n2. 重连后自动回到原会话\n3. 断线不清空会话上下文'),
    ],
  };

  await credentialStore.save(
    const SavedDeviceCredential(
      machineId: 'machine_mac',
      wsUrl: 'ws://127.0.0.1:4100',
      deviceId: 'dev_demo',
      deviceToken: 'ntk_demo_token',
      relayUrl: 'wss://nienie-replay.quniv.cn',
    ),
  );

  final client = MobileBridgeClient(
    transport: transport,
    credentialStore: credentialStore,
    language: language,
  );
  await client.pairAndConnect(
    wsUrl: 'ws://127.0.0.1:4100',
    pairingCode: '123456',
    deviceName: 'iPhone',
    platform: 'ios',
  );
  await client.openSession(
    const AgentSession(
      id: 'ses_alpha',
      agentId: 'opencode',
      title: 'Implement OpenCode adapter',
      projectPath: '/workspace/nienie',
      status: 'idle',
    ),
  );
  return client;
}

Map<String, dynamic> _message(
        String partId, int ordinal, String role, String text) =>
    {
      'kind': 'message',
      'partId': partId,
      'ordinal': ordinal,
      'revision': 1,
      'createdAt': DateTime.now().toIso8601String(),
      'updatedAt': DateTime.now().toIso8601String(),
      'role': role,
      'content': [
        {'type': 'text', 'text': text}
      ],
    };

Map<String, dynamic> _tool(
  String partId,
  int ordinal,
  String toolCallId,
  String name,
  Map<String, dynamic> input,
  String status,
  String? output,
) {
  final started = DateTime.now().subtract(Duration(seconds: 30 - ordinal * 4));
  return {
    'kind': 'tool_call',
    'partId': partId,
    'ordinal': ordinal,
    'revision': 1,
    'createdAt': DateTime.now().toIso8601String(),
    'updatedAt': DateTime.now().toIso8601String(),
    'toolCallId': toolCallId,
    'name': name,
    'input': input,
    // 状态白名单：pending / running / completed / failed（'done' 会被快照校验拒收）
    'status': status,
    // 结果字段名必须是 output（与 session.snapshot 协议一致，content 会被解析丢弃）
    if (output != null) 'output': output,
    'isError': false,
    'toolStartedAt': started.toIso8601String(),
    'toolFinishedAt': started.add(Duration(seconds: 3 + ordinal)).toIso8601String(),
  };
}
