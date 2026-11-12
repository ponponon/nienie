import 'dart:convert';
import 'dart:io';
import '../i18n/app_strings.dart';

class SavedDeviceCredential {
  final String machineId;
  final String wsUrl;
  final String deviceId;
  final String deviceToken;
  /** 公网 Relay 地址（稳定，LAN IP 变化时的回退通道）。 */
  final String? relayUrl;

  const SavedDeviceCredential({
    required this.machineId,
    required this.wsUrl,
    required this.deviceId,
    required this.deviceToken,
    this.relayUrl,
  });

  Map<String, dynamic> toJson() => {
        'machineId': machineId,
        'wsUrl': wsUrl,
        'deviceId': deviceId,
        'deviceToken': deviceToken,
        if (relayUrl != null) 'relayUrl': relayUrl,
      };

  factory SavedDeviceCredential.fromJson(Map<String, dynamic> json) {
    return SavedDeviceCredential(
      machineId: json['machineId'] as String,
      wsUrl: json['wsUrl'] as String,
      deviceId: json['deviceId'] as String,
      deviceToken: json['deviceToken'] as String,
      relayUrl: json['relayUrl'] as String?,
    );
  }
}

abstract class DeviceCredentialStore {
  Future<void> save(SavedDeviceCredential credential);
  Future<SavedDeviceCredential?> load([String? machineId]);
  Future<List<SavedDeviceCredential>> listMachines();
  Future<void> removeMachine(String machineId);
  Future<void> saveLanguage(AppLanguage language);
  Future<AppLanguage?> loadLanguage();

  /// 5.1：快捷指令自定义（scope=agentId）；null=该 scope 无自定义（用内置默认）
  Future<void> saveQuickCommands(String scope, List<String> commands);
  Future<List<String>?> loadQuickCommands(String scope);
  Future<void> clear();
}

class InMemoryCredentialStore implements DeviceCredentialStore {
  final Map<String, SavedDeviceCredential> _machines = {};
  String? _activeMachineId;
  AppLanguage? _savedLanguage;

  @override
  Future<void> save(SavedDeviceCredential credential) async {
    _machines[credential.machineId] = credential;
    _activeMachineId = credential.machineId;
  }

  @override
  Future<SavedDeviceCredential?> load([String? machineId]) async {
    final targetId = machineId ?? _activeMachineId;
    if (targetId == null) return null;
    return _machines[targetId];
  }

  @override
  Future<List<SavedDeviceCredential>> listMachines() async {
    return List.unmodifiable(_machines.values);
  }

  @override
  Future<void> removeMachine(String machineId) async {
    _machines.remove(machineId);
    if (_activeMachineId == machineId) {
      _activeMachineId = _machines.keys.firstOrNull;
    }
  }

  @override
  Future<void> saveLanguage(AppLanguage language) async {
    _savedLanguage = language;
  }

  @override
  Future<AppLanguage?> loadLanguage() async => _savedLanguage;

  final Map<String, List<String>> _quickCommands = {};

  @override
  Future<void> saveQuickCommands(String scope, List<String> commands) async {
    _quickCommands[scope] = List<String>.of(commands);
  }

  @override
  Future<List<String>?> loadQuickCommands(String scope) async {
    final value = _quickCommands[scope];
    return value == null ? null : List<String>.of(value);
  }

  @override
  Future<void> clear() async {
    _quickCommands.clear(); // P2：快捷指令随清空一并清理（与 File 实现语义一致）
    _machines.clear();
    _activeMachineId = null;
    _savedLanguage = null;
  }
}

class FileCredentialStore implements DeviceCredentialStore {
  final File file;

  const FileCredentialStore(this.file);

  Future<Map<String, dynamic>> _readState() async {
    if (!await file.exists()) {
      return {'activeMachineId': null, 'machines': <String, dynamic>{}};
    }
    final text = await file.readAsString();
    if (text.trim().isEmpty) {
      return {'activeMachineId': null, 'machines': <String, dynamic>{}};
    }
    return Map<String, dynamic>.from(jsonDecode(text) as Map);
  }

  Future<void> _writeState(Map<String, dynamic> state) async {
    await file.parent.create(recursive: true);
    await file.writeAsString(jsonEncode(state));
  }

  @override
  Future<void> save(SavedDeviceCredential credential) async {
    final state = await _readState();
    final machines = Map<String, dynamic>.from(
      state['machines'] as Map? ?? const {},
    );
    machines[credential.machineId] = credential.toJson();
    state['machines'] = machines;
    state['activeMachineId'] = credential.machineId;
    await _writeState(state);
  }

  @override
  Future<SavedDeviceCredential?> load([String? machineId]) async {
    final state = await _readState();
    final targetId = machineId ?? state['activeMachineId'] as String?;
    if (targetId == null) return null;
    final machines = Map<String, dynamic>.from(
      state['machines'] as Map? ?? const {},
    );
    final raw = machines[targetId];
    if (raw == null) return null;
    return SavedDeviceCredential.fromJson(Map<String, dynamic>.from(raw as Map));
  }

  @override
  Future<List<SavedDeviceCredential>> listMachines() async {
    final state = await _readState();
    final machines = Map<String, dynamic>.from(
      state['machines'] as Map? ?? const {},
    );
    return machines.values
        .map((raw) => SavedDeviceCredential.fromJson(Map<String, dynamic>.from(raw as Map)))
        .toList();
  }

  @override
  Future<void> removeMachine(String machineId) async {
    final state = await _readState();
    final machines = Map<String, dynamic>.from(
      state['machines'] as Map? ?? const {},
    );
    machines.remove(machineId);
    state['machines'] = machines;
    if (state['activeMachineId'] == machineId) {
      state['activeMachineId'] = machines.keys.firstOrNull;
    }
    await _writeState(state);
  }

  @override
  Future<void> saveLanguage(AppLanguage language) async {
    final state = await _readState();
    state['language'] = language.name;
    await _writeState(state);
  }

  @override
  Future<AppLanguage?> loadLanguage() async {
    final state = await _readState();
    final raw = state['language'] as String?;
    if (raw == null) return null;
    for (final lang in AppLanguage.values) {
      if (lang.name == raw) return lang;
    }
    return null;
  }

  @override
  Future<void> saveQuickCommands(String scope, List<String> commands) async {
    final state = await _readState();
    final all = Map<String, dynamic>.from(
      state['quickCommands'] as Map? ?? const {},
    );
    all[scope] = commands;
    state['quickCommands'] = all;
    await _writeState(state);
  }

  @override
  Future<List<String>?> loadQuickCommands(String scope) async {
    final state = await _readState();
    final all = state['quickCommands'] as Map?;
    if (all == null || all[scope] == null) return null;
    return (all[scope] as List).cast<String>();
  }

  @override
  Future<void> clear() async {
    if (await file.exists()) {
      await file.delete();
    }
  }
}
