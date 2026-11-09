import 'dart:convert';

const int PROTOCOL_VERSION = 1;
const String DEFAULT_RELAY_URL = 'wss://nienie-replay.quniv.cn';

class PairingQrPayload {
  final int version;
  final String machineId;
  final String wsUrl;
  final String relayUrl;
  final String pairingCode;
  final String expiresAt;

  const PairingQrPayload({
    required this.version,
    required this.machineId,
    required this.wsUrl,
    required this.relayUrl,
    required this.pairingCode,
    required this.expiresAt,
  });

  static PairingQrPayload decode(String input) {
    final trimmed = input.trim();
    String jsonText = trimmed;
    if (trimmed.startsWith('nienie://')) {
      final uri = Uri.parse(trimmed);
      final dataParam = uri.queryParameters['data'];
      if (dataParam == null || dataParam.isEmpty) {
        throw const FormatException('Missing data parameter in pairing URI');
      }
      final normalized = base64Url.normalize(dataParam);
      jsonText = utf8.decode(base64Url.decode(normalized));
    }

    final map = jsonDecode(jsonText) as Map<String, dynamic>;
    final version = map['version'];
    if (version != PROTOCOL_VERSION) {
      throw FormatException('Unsupported pairing QR version: $version');
    }

    final customRelay = (map['relayUrl'] as String?)?.trim();
    return PairingQrPayload(
      version: PROTOCOL_VERSION,
      machineId: map['machineId'] as String,
      wsUrl: map['wsUrl'] as String,
      relayUrl: (customRelay != null && customRelay.isNotEmpty)
          ? customRelay
          : DEFAULT_RELAY_URL,
      pairingCode: map['pairingCode'] as String,
      expiresAt: map['expiresAt'] as String,
    );
  }
}

class AgentInfo {
  final String id;
  final String name;
  final bool available;
  final String? version;

  const AgentInfo({
    required this.id,
    required this.name,
    required this.available,
    this.version,
  });

  factory AgentInfo.fromJson(Map<String, dynamic> json) {
    return AgentInfo(
      id: json['id'] as String,
      name: json['name'] as String,
      available: json['available'] as bool? ?? false,
      version: json['version'] as String?,
    );
  }
}

class ModelInfo {
  final String id;
  final String name;
  final String providerId;
  final String providerName;
  final bool isDefault;

  const ModelInfo({
    required this.id,
    required this.name,
    required this.providerId,
    required this.providerName,
    required this.isDefault,
  });

  factory ModelInfo.fromJson(Map<String, dynamic> json) {
    return ModelInfo(
      id: json['id'] as String,
      name: json['name'] as String? ?? json['id'] as String,
      providerId: json['providerId'] as String? ?? '',
      providerName: json['providerName'] as String? ?? json['providerId'] as String? ?? '',
      isDefault: json['isDefault'] as bool? ?? false,
    );
  }
}

class AgentSession {
  final String id;
  final String agentId;
  final String title;
  final String projectPath;
  final String status;

  const AgentSession({
    required this.id,
    required this.agentId,
    required this.title,
    required this.projectPath,
    required this.status,
  });

  factory AgentSession.fromJson(Map<String, dynamic> json) {
    return AgentSession(
      id: json['id'] as String,
      agentId: json['agentId'] as String,
      title: json['title'] as String? ?? 'Untitled',
      projectPath: json['projectPath'] as String? ?? '',
      status: json['status'] as String? ?? 'idle',
    );
  }
}

class CanonicalAgentEvent {
  final int version;
  final String eventId;
  final String streamEpoch;
  final String sessionId;
  final int sequence;
  final String timestamp;
  final String type;
  final Map<String, dynamic> payload;

  const CanonicalAgentEvent({
    required this.version,
    required this.eventId,
    required this.streamEpoch,
    required this.sessionId,
    required this.sequence,
    required this.timestamp,
    required this.type,
    required this.payload,
  });

  factory CanonicalAgentEvent.fromJson(Map<String, dynamic> json) {
    return CanonicalAgentEvent(
      version: json['version'] as int? ?? PROTOCOL_VERSION,
      eventId: json['eventId'] as String? ?? '',
      streamEpoch: json['streamEpoch'] as String? ?? '',
      sessionId: json['sessionId'] as String,
      sequence: json['sequence'] as int,
      timestamp: json['timestamp'] as String? ?? '',
      type: json['type'] as String,
      payload: Map<String, dynamic>.from(json['payload'] as Map? ?? const {}),
    );
  }
}
