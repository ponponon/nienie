import 'dart:async';
import '../models/protocol_models.dart';
import 'bridge_transport.dart';

class FakeBridgeTransport implements BridgeTransport {
  final StreamController<Map<String, dynamic>> _incomingController =
      StreamController<Map<String, dynamic>>.broadcast();
  final List<String> sentPrompts = [];
  final List<String?> sentModelIds = [];
  final List<String?> sentClientMessageIds = [];
  bool diffUnavailable = false;
  /// 下一次 session.send 返回失败（路线图 3.3 送达回执测试用）
  bool failNextSend = false;
  /// 下一次 session.send 抛出传输异常（receipt 永久 pending 回归测试用）
  bool throwNextSend = false;
  /// F1：session.send 响应闸门（测试延迟接受竞态：complete 后才回响应）
  Completer<void>? sendGate;
  /// 接下来 N 次 hello 失败（模拟重连逐次失败）
  int failHelloCount = 0;
  /// ok | missing | notOk | missingReplied | missingSessionId | missingPermissionId |
  /// missingDecision | sessionIdMismatch | permissionIdMismatch | decisionMismatch
  String permissionReplyEchoMode = 'ok';
  /// 挂起 permission.reply 响应（竞态测试用）：complete 后才返回
  Completer<void>? permissionReplyGate;
  List<Map<String, dynamic>> diffResponse = [
    {
      'diffId': 'd1',
      'file': 'src/index.ts',
      'before': 'a',
      'after': 'b',
      'additions': 3,
      'deletions': 1,
    },
  ];
  final List<String> cancelledSessionIds = [];
  final List<Map<String, String>> permissionReplies = [];
  final List<Map<String, String>> registeredPushes = [];
  Map<String, dynamic>? snapshotResponse;
  /// Round2 测试钩子：下一次 session.load 失败（打开失败保留未读用）
  bool failSessionLoadOnce = false;
  /// Round3 测试钩子：events.replay 请求计数（重复 Replay 消除验证）
  int replayRequests = 0;
  /// FinalQA 测试钩子：返回空会话列表（电脑未开 Agent 场景）
  bool emptySessions = false;
  String? helloMachineId;
  bool omitHelloMachineId = false;

  @override
  Stream<Map<String, dynamic>> get incomingMessages => _incomingController.stream;

  @override
  Future<void> connect(String wsUrl) async {}

  @override
  Future<Map<String, dynamic>> sendRequest(Map<String, dynamic> request) async {
    final requestId = request['requestId'] as String;
    final type = request['type'] as String;

    switch (type) {
      case 'pair.confirm':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'deviceId': 'dev_mobile_1',
            'deviceToken': 'ntk_fake_token_1234567890',
            'machineId': helloMachineId ?? 'machine_mac',
            'pairedAt': '2026-11-04T10:00:00Z',
          },
        };
      case 'hello':
        if (failHelloCount > 0) {
          failHelloCount -= 1;
          return {
            'type': 'response',
            'requestId': requestId,
            'ok': false,
            'error': {'code': 'BAD_TOKEN', 'message': 'hello failed'},
          };
        }
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'protocolVersion': PROTOCOL_VERSION,
            if (!omitHelloMachineId) 'machineId': helloMachineId ?? 'machine_mac',
            'authenticated': true,
          },
        };
      case 'agents.list':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'agents': [
              {'id': 'opencode', 'name': 'OpenCode', 'available': true, 'version': '0.15.2'},
              {'id': 'codex', 'name': 'Codex', 'available': false},
            ],
          },
        };
      case 'models.list':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'agentId': request['agentId'],
            'models': [
              {
                'id': 'anthropic/claude-sonnet-4',
                'name': 'Claude Sonnet 4',
                'providerId': 'anthropic',
                'isDefault': true,
              },
            ],
          },
        };
      case 'sessions.list':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'sessions': emptySessions ? [] : [
              {
                'id': 'ses_alpha',
                'agentId': 'opencode',
                'title': 'Implement OpenCode adapter',
                'projectPath': '/workspace/nienie',
                'status': 'idle',
                'createdAt': DateTime.now().subtract(const Duration(hours: 1)).toIso8601String(),
                'updatedAt': DateTime.now().subtract(const Duration(minutes: 3)).toIso8601String(),
              },
              {
                'id': 'ses_beta',
                'agentId': 'opencode',
                'title': 'Fix login crash',
                'projectPath': '/workspace/webapp',
                'status': 'idle',
                'createdAt': DateTime.now().subtract(const Duration(days: 1)).toIso8601String(),
                'updatedAt': DateTime.now().subtract(const Duration(hours: 2)).toIso8601String(),
              },
            ],
          },
        };
      case 'session.load':
        if (failSessionLoadOnce) {
          failSessionLoadOnce = false;
          return {
            'type': 'response',
            'requestId': requestId,
            'ok': false,
            'error': {'code': 'LOAD_FAILED', 'message': 'session load failed'},
          };
        }
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'session': {
              'id': request['sessionId'],
              'agentId': request['agentId'],
              'title': 'Implement OpenCode adapter',
              'projectPath': '/workspace/nienie',
              'status': 'idle',
            },
          },
        };
      case 'session.create':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'session': {
              'id': 'ses_created_mobile',
              'agentId': request['agentId'],
              'title': (request['input'] as Map?)?['title'] ?? 'New Session',
              'projectPath': '/workspace/nienie',
              'status': 'idle',
            },
          },
        };
      case 'session.send':
        if (sendGate != null) {
          await sendGate!.future;
        }
        if (throwNextSend) {
          throwNextSend = false;
          throw Exception('transport broken');
        }
        if (failNextSend) {
          failNextSend = false;
          return {
            'type': 'response',
            'requestId': requestId,
            'ok': false,
            'error': {'code': 'SEND_FAILED', 'message': 'transport error'},
          };
        }
        sentPrompts.add(request['message'] as String);
        sentModelIds.add(request['modelId'] as String?);
        sentClientMessageIds.add(request['clientMessageId'] as String?);
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'accepted': true,
            'sessionId': request['sessionId'],
            // 模拟 v2：服务端回显权威 messageId（与客户端预生成 ID 一致）
            if (request['clientMessageId'] != null) 'messageId': request['clientMessageId'],
          },
        };
      case 'session.snapshot':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data':
              snapshotResponse ??
              {
                'schemaVersion': 1,
                'snapshotId': 'snap_test',
                'sessionId': request['sessionId'],
                'agentId': 'opencode',
                'streamEpoch': 'ep_snap',
                'watermark': 5,
                'capturedAt': '2026-11-10T00:00:00Z',
                'complete': true,
                'hasMore': false,
                // 默认空快照（openSession 统一恢复后不污染既有测试时间线；
                // 需要快照内容的测试显式设置 snapshotResponse）
                'totalParts': 0,
                'parts': [],
              },
        };
      case 'events.replay':
        replayRequests += 1;
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {'events': []},
        };
      case 'session.cancel':
        cancelledSessionIds.add(request['sessionId'] as String);
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {'cancelled': true, 'sessionId': request['sessionId']},
        };
      case 'permission.reply':
        permissionReplies.add({
          'sessionId': request['sessionId'] as String,
          'permissionId': request['permissionId'] as String,
          'decision': request['decision'] as String,
        });
        if (permissionReplyGate != null) {
          await permissionReplyGate!.future;
        }
        if (permissionReplyEchoMode == 'missing') {
          return {'type': 'response', 'requestId': requestId, 'ok': true};
        }
        if (permissionReplyEchoMode == 'notOk') {
          return {'type': 'response', 'requestId': requestId, 'ok': false};
        }
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            if (permissionReplyEchoMode != 'missingReplied') 'replied': true,
            if (permissionReplyEchoMode != 'missingSessionId')
              'sessionId': permissionReplyEchoMode == 'sessionIdMismatch'
                  ? 'ses_other'
                  : request['sessionId'],
            if (permissionReplyEchoMode != 'missingPermissionId')
              'permissionId': permissionReplyEchoMode == 'permissionIdMismatch'
                  ? '${request['permissionId']}_mismatch'
                  : request['permissionId'],
            if (permissionReplyEchoMode != 'missingDecision')
              'decision': permissionReplyEchoMode == 'decisionMismatch'
                  ? 'allow_always'
                  : request['decision'],
          },
        };
      case 'session.diff':
        if (diffUnavailable) {
          return {
            'type': 'response',
            'requestId': requestId,
            'ok': true,
            'data': {'sessionId': request['sessionId'], 'diffs': [], 'unavailable': true},
          };
        }
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'sessionId': request['sessionId'],
            'diffs': diffResponse,
          },
        };
      case 'push.register':
        registeredPushes.add({
          'platform': request['platform'] as String,
          'provider': request['provider'] as String,
          'pushToken': request['pushToken'] as String,
        });
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'registered': true,
            'provider': request['provider'],
          },
        };
      case 'screen.capture':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'frame': {
              'frameId': 'frm_mobile_1',
              'displayId': request['displayId'] ?? 'main',
              'mimeType': 'image/png',
              'width': 1440,
              'height': 900,
              'base64Data': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
              'capturedAt': '2026-11-04T10:00:00Z',
            },
          },
        };
      default:
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': false,
          'error': {'code': 'UNKNOWN', 'message': 'Unsupported fake command'},
        };
    }
  }

  /// 注入任意原始帧（如 transport.disconnected），模拟底层连接事件（路线图 3.2 测试用）
  void emitRaw(Map<String, dynamic> raw) {
    _incomingController.add(raw);
  }

  void emitServerEvent(Map<String, dynamic> canonicalEvent) {
    _incomingController.add({
      'type': 'session.event',
      'event': canonicalEvent,
    });
  }

  @override
  Future<void> close() async {}
}
