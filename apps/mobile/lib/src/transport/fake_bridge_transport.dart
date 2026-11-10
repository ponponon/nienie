import 'dart:async';
import '../models/protocol_models.dart';
import 'bridge_transport.dart';

class FakeBridgeTransport implements BridgeTransport {
  final StreamController<Map<String, dynamic>> _incomingController =
      StreamController<Map<String, dynamic>>.broadcast();
  final List<String> sentPrompts = [];
  final List<String?> sentModelIds = [];
  final List<String> cancelledSessionIds = [];
  final List<Map<String, String>> permissionReplies = [];
  final List<Map<String, String>> registeredPushes = [];
  Map<String, dynamic>? snapshotResponse;
  String? helloMachineId;

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
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'protocolVersion': PROTOCOL_VERSION,
            'machineId': helloMachineId ?? 'machine_mac',
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
            'sessions': [
              {
                'id': 'ses_alpha',
                'agentId': 'opencode',
                'title': 'Implement OpenCode adapter',
                'projectPath': '/workspace/nienie',
                'status': 'idle',
              },
            ],
          },
        };
      case 'session.load':
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
        sentPrompts.add(request['message'] as String);
        sentModelIds.add(request['modelId'] as String?);
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {'accepted': true, 'sessionId': request['sessionId']},
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
                'totalParts': 1,
                'parts': [
                  {
                    'kind': 'message',
                    'partId': 'p1',
                    'ordinal': 0,
                    'revision': 1,
                    'createdAt': '2026-11-10T00:00:00Z',
                    'updatedAt': '2026-11-10T00:00:00Z',
                    'role': 'assistant',
                    'content': [
                      {'type': 'text', 'text': 'Snapshot content'},
                    ],
                  },
                ],
              },
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
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'replied': true,
            'sessionId': request['sessionId'],
            'permissionId': request['permissionId'],
            'decision': request['decision'],
          },
        };
      case 'session.diff':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'sessionId': request['sessionId'],
            'diffs': [
              {
                'file': 'src/index.ts',
                'before': 'a',
                'after': 'b',
                'additions': 3,
                'deletions': 1,
              },
            ],
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

  void emitServerEvent(Map<String, dynamic> canonicalEvent) {
    _incomingController.add({
      'type': 'session.event',
      'event': canonicalEvent,
    });
  }

  @override
  Future<void> close() async {}
}
