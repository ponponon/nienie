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
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      children: [
        // 1. Top Priority if available: One-tap reconnect to saved computers
        if (client.savedMachines.isNotEmpty)
          Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: const Color(0xFFFFFFFF),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  s.savedComputersTitle,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF181818),
                  ),
                ),
                const SizedBox(height: 6),
                for (final machine in client.savedMachines)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(
                      children: [
                        const Icon(Icons.laptop_mac, size: 16, color: Color(0xFF07C160)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Row(
                            children: [
                              Text(
                                machine.machineId,
                                style: const TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600,
                                  color: Color(0xFF181818),
                                ),
                              ),
                              const SizedBox(width: 6),
                              Flexible(
                                child: Text(
                                  machine.wsUrl,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    color: Color(0xFF8E8E93),
                                  ),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ],
                          ),
                        ),
                        SizedBox(
                          height: 30,
                          child: FilledButton.tonal(
                            key: Key('btn-reconnect-machine-${machine.machineId}'),
                            style: FilledButton.styleFrom(
                              backgroundColor: const Color(0xFF07C160).withValues(alpha: 0.12),
                              foregroundColor: const Color(0xFF07C160),
                              padding: const EdgeInsets.symmetric(horizontal: 10),
                            ),
                            onPressed: () =>
                                client.reconnectWithSavedCredential(machine.machineId),
                            child: Text(s.reconnectBtn, style: const TextStyle(fontSize: 12)),
                          ),
                        ),
                        IconButton(
                          key: Key('btn-remove-machine-${machine.machineId}'),
                          visualDensity: VisualDensity.compact,
                          tooltip: 'Remove Machine',
                          onPressed: () => client.removeSavedMachine(machine.machineId),
                          icon: const Icon(
                            Icons.delete_outline,
                            size: 16,
                            color: Color(0xFF8E8E93),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),

        // 2. Primary Action: Compact One-Time Code + WS URL Pairing Card
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: const Color(0xFFFFFFFF),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(Icons.phonelink_ring, size: 16, color: Color(0xFF07C160)),
                  const SizedBox(width: 6),
                  Text(
                    s.connectTitle,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF181818),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    flex: 3,
                    child: TextField(
                      key: const Key('input-ws-url'),
                      controller: wsUrlController,
                      style: const TextStyle(fontSize: 13, color: Color(0xFF181818)),
                      decoration: InputDecoration(
                        labelText: s.wsUrlLabel,
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 10,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    flex: 2,
                    child: TextField(
                      key: const Key('input-pairing-code'),
                      controller: pairingCodeController,
                      keyboardType: TextInputType.number,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: Color(0xFF07C160),
                      ),
                      decoration: InputDecoration(
                        labelText: s.pairingCodeLabel,
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 10,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              SizedBox(
                height: 38,
                child: FilledButton.icon(
                  key: const Key('btn-connect-pair'),
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFF07C160),
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                  onPressed: () {
                    client.pairAndConnect(
                      wsUrl: wsUrlController.text,
                      pairingCode: pairingCodeController.text,
                    );
                  },
                  icon: const Icon(Icons.link, size: 16),
                  label: Text(
                    s.pairAndConnectBtn,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
              ),
              const SizedBox(height: 10),
              // Secondary Action: Single-row compact QR URI paste
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('input-qr-uri'),
                      controller: qrUriController,
                      style: const TextStyle(fontSize: 12, color: Color(0xFF181818)),
                      decoration: InputDecoration(
                        labelText: s.qrUriLabel,
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 8,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    height: 34,
                    child: OutlinedButton.icon(
                      key: const Key('btn-pair-qr-uri'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFF07C160),
                        padding: const EdgeInsets.symmetric(horizontal: 10),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
                      onPressed: () {
                        client.pairWithQrUri(qrUriController.text);
                      },
                      icon: const Icon(Icons.qr_code, size: 14),
                      label: Text(s.pairWithQrBtn, style: const TextStyle(fontSize: 12)),
                    ),
                  ),
                ],
              ),
              if (client.errorMessage != null) ...[
                const SizedBox(height: 8),
                Text(
                  client.errorMessage!,
                  style: const TextStyle(color: Color(0xFFFA5151), fontSize: 12),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
