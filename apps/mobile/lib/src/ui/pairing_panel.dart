import 'package:flutter/material.dart';
import '../state/mobile_bridge_client.dart';

class PairingPanel extends StatelessWidget {
  final MobileBridgeClient client;
  final TextEditingController wsUrlController;
  final TextEditingController pairingCodeController;
  final TextEditingController qrUriController;

  const PairingPanel({
    super.key,
    required this.client,
    required this.wsUrlController,
    required this.pairingCodeController,
    required this.qrUriController,
  });

  @override
  Widget build(BuildContext context) {
    final s = client.strings;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const Icon(Icons.qr_code_scanner, size: 18, color: Color(0xFF3B82F6)),
                    const SizedBox(width: 8),
                    Text(
                      s.connectTitle,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('input-ws-url'),
                  controller: wsUrlController,
                  decoration: InputDecoration(
                    labelText: s.wsUrlLabel,
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('input-pairing-code'),
                  controller: pairingCodeController,
                  decoration: InputDecoration(
                    labelText: s.pairingCodeLabel,
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  key: const Key('btn-connect-pair'),
                  onPressed: () {
                    client.pairAndConnect(
                      wsUrl: wsUrlController.text,
                      pairingCode: pairingCodeController.text,
                    );
                  },
                  icon: const Icon(Icons.link),
                  label: Text(s.pairAndConnectBtn),
                ),
                const SizedBox(height: 16),
                TextField(
                  key: const Key('input-qr-uri'),
                  controller: qrUriController,
                  decoration: InputDecoration(
                    labelText: s.qrUriLabel,
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  key: const Key('btn-pair-qr-uri'),
                  onPressed: () {
                    client.pairWithQrUri(qrUriController.text);
                  },
                  icon: const Icon(Icons.qr_code),
                  label: Text(s.pairWithQrBtn),
                ),
                if (client.savedMachines.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  Text(
                    s.savedComputersTitle,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 8),
                  for (final machine in client.savedMachines)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Row(
                        children: [
                          const Icon(Icons.computer, size: 16, color: Color(0xFF10B981)),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  machine.machineId,
                                  style: const TextStyle(fontWeight: FontWeight.w600),
                                ),
                                Text(
                                  machine.wsUrl,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    color: Color(0xFF9CA3AF),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          FilledButton.tonal(
                            key: Key('btn-reconnect-machine-${machine.machineId}'),
                            onPressed: () =>
                                client.reconnectWithSavedCredential(machine.machineId),
                            child: Text(s.reconnectBtn),
                          ),
                          const SizedBox(width: 4),
                          IconButton(
                            key: Key('btn-remove-machine-${machine.machineId}'),
                            tooltip: 'Remove Machine',
                            onPressed: () => client.removeSavedMachine(machine.machineId),
                            icon: const Icon(Icons.delete_outline, size: 18),
                          ),
                        ],
                      ),
                    ),
                ],
                if (client.errorMessage != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    client.errorMessage!,
                    style: const TextStyle(color: Color(0xFFEF4444)),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}
