import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/protocol_models.dart';
import '../state/mobile_bridge_client.dart';
import 'qr_scanner_sheet.dart';

class PairingPanel extends StatefulWidget {
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
  State<PairingPanel> createState() => _PairingPanelState();
}

class _PairingPanelState extends State<PairingPanel> {
  bool _showAdvanced = false;

  static const Color _weTypeGreen = Color(0xFF17B378);
  static const Color _textPrimary = Color(0xFF141416);
  static const Color _textSecondary = Color(0xFF6E7178);
  static const Color _dividerColor = Color(0x0E000000);
  static const Color _cardBorder = Color(0x12000000);
  static const Color _btnBorderColor = Color(0xFFDCDFE4);

  void _openCameraScanner(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (sheetCtx) => QrScannerSheet(
        client: widget.client,
        onDetected: (rawUri) {
          widget.qrUriController.text = rawUri;
          try {
            final decoded = PairingQrPayload.decode(rawUri);
            widget.wsUrlController.text = decoded.wsUrl;
            widget.pairingCodeController.text = decoded.pairingCode;
          } catch (_) {}
          widget.client.pairWithQrUri(rawUri);
        },
      ),
    );
  }

  Widget _buildIconBadge(IconData icon, {bool active = false}) {
    return Container(
      width: 34,
      height: 34,
      decoration: BoxDecoration(
        color: active ? _weTypeGreen.withValues(alpha: 0.1) : const Color(0xFFF5F6F8),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(
          color: active ? _weTypeGreen.withValues(alpha: 0.22) : const Color(0x0D000000),
        ),
      ),
      alignment: Alignment.center,
      child: Icon(
        icon,
        size: 16,
        color: active ? _weTypeGreen : const Color(0xFF52555D),
      ),
    );
  }

  BoxDecoration _cardDecoration() {
    return BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(13),
      border: Border.all(color: _cardBorder),
      boxShadow: const [
        BoxShadow(
          color: Color(0x06000000),
          blurRadius: 10,
          offset: Offset(0, 2),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final client = widget.client;
    final s = client.strings;
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 2, bottom: 12),
          child: Text(
            s.connectTitle,
            style: const TextStyle(
              fontSize: 16.5,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.3,
              color: _textPrimary,
            ),
          ),
        ),

        // Group 1: Saved Computers (WeType + shadcn Grouped Card)
        if (client.savedMachines.isNotEmpty)
          Container(
            margin: const EdgeInsets.only(bottom: 14),
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: _cardDecoration(),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (int i = 0; i < client.savedMachines.length; i++) ...[
                  if (i > 0) const Divider(height: 1, color: _dividerColor),
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 13),
                    child: Row(
                      children: [
                        _buildIconBadge(LucideIcons.laptop, active: true),
                        const SizedBox(width: 11),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                client.savedMachines[i].machineId,
                                style: const TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w600,
                                  color: _textPrimary,
                                ),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                client.savedMachines[i].wsUrl,
                                style: const TextStyle(
                                  fontSize: 11.5,
                                  fontFamily: 'monospace',
                                  color: _textSecondary,
                                ),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ],
                          ),
                        ),
                        SizedBox(
                          height: 30,
                          child: OutlinedButton(
                            key: Key(
                              'btn-reconnect-machine-${client.savedMachines[i].machineId}',
                            ),
                            style: OutlinedButton.styleFrom(
                              foregroundColor: _textPrimary,
                              side: const BorderSide(color: _btnBorderColor),
                              padding: const EdgeInsets.symmetric(horizontal: 12),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(7),
                              ),
                            ),
                            onPressed: () => client.reconnectWithSavedCredential(
                              client.savedMachines[i].machineId,
                            ),
                            child: Text(
                              s.reconnectBtn,
                              style: const TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ),
                        ),
                        IconButton(
                          key: Key('btn-remove-machine-${client.savedMachines[i].machineId}'),
                          visualDensity: VisualDensity.compact,
                          tooltip: client.strings.tooltipRemoveMachine,
                          onPressed: () => client.removeSavedMachine(
                            client.savedMachines[i].machineId,
                          ),
                          icon: const Icon(
                            LucideIcons.trash2,
                            size: 15,
                            color: _textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),

        // Group 2: Primary Pairing Card
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: _cardDecoration(),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Row 1: Camera QR Scan
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 15),
                child: Row(
                  children: [
                    _buildIconBadge(LucideIcons.scanLine, active: true),
                    const SizedBox(width: 11),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            s.scanQrBtn,
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                              color: _textPrimary,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            s.scanQrHint,
                            style: const TextStyle(
                              fontSize: 12,
                              color: _textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 10),
                    SizedBox(
                      height: 34,
                      child: FilledButton.icon(
                        key: const Key('btn-open-qr-scanner'),
                        style: FilledButton.styleFrom(
                          backgroundColor: _weTypeGreen,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(horizontal: 13),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                        ),
                        onPressed: () => _openCameraScanner(context),
                        icon: const Icon(LucideIcons.qrCode, size: 15),
                        label: const Text(
                          'QR',
                          style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1, color: _dividerColor),
              // Row 2: 6-Digit Pairing Code
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 13),
                child: Row(
                  children: [
                    _buildIconBadge(LucideIcons.keyRound),
                    const SizedBox(width: 11),
                    Expanded(
                      child: TextField(
                        key: const Key('input-pairing-code'),
                        controller: widget.pairingCodeController,
                        keyboardType: TextInputType.number,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 1.5,
                          color: _textPrimary,
                        ),
                        decoration: InputDecoration(
                          hintText: s.pairingCodeLabel,
                          hintStyle: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w400,
                            letterSpacing: 0,
                            color: _textSecondary,
                          ),
                          isDense: true,
                          border: InputBorder.none,
                          contentPadding: const EdgeInsets.symmetric(vertical: 6),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    SizedBox(
                      height: 32,
                      child: OutlinedButton(
                        key: const Key('btn-connect-pair'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: _textPrimary,
                          side: const BorderSide(color: _btnBorderColor),
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(7),
                          ),
                        ),
                        onPressed: () {
                          client.pairAndConnect(
                            wsUrl: widget.wsUrlController.text,
                            pairingCode: widget.pairingCodeController.text,
                          );
                        },
                        child: Text(
                          s.pairAndConnectBtn,
                          style: const TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              if (client.errorMessage != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Row(
                    children: [
                      const Icon(LucideIcons.circleAlert, size: 14, color: Color(0xFFEF4444)),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          client.errorMessage!,
                          style: const TextStyle(color: Color(0xFFEF4444), fontSize: 12),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),

        // Progressive Disclosure: Advanced Options
        const SizedBox(height: 8),
        Center(
          child: TextButton.icon(
            key: const Key('btn-toggle-advanced'),
            onPressed: () => setState(() => _showAdvanced = !_showAdvanced),
            icon: Icon(
              _showAdvanced ? LucideIcons.chevronUp : LucideIcons.chevronDown,
              size: 15,
              color: _textSecondary,
            ),
            label: Text(
              s.advancedOptionsLabel,
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: _textSecondary,
              ),
            ),
          ),
        ),
        if (_showAdvanced)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            decoration: _cardDecoration(),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  s.wsUrlLabel,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w500,
                    color: _textSecondary,
                  ),
                ),
                const SizedBox(height: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 2),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF6F7F9),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0x12000000)),
                  ),
                  child: TextField(
                    key: const Key('input-ws-url'),
                    controller: widget.wsUrlController,
                    style: const TextStyle(
                      fontSize: 13,
                      fontFamily: 'monospace',
                      color: _textPrimary,
                    ),
                    decoration: const InputDecoration(
                      border: InputBorder.none,
                      isDense: true,
                      contentPadding: EdgeInsets.symmetric(vertical: 8),
                    ),
                  ),
                ),
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 12),
                  child: Divider(height: 1, color: _dividerColor),
                ),
                Text(
                  s.qrUriLabel,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w500,
                    color: _textSecondary,
                  ),
                ),
                const SizedBox(height: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 2),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF6F7F9),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0x12000000)),
                  ),
                  child: TextField(
                    key: const Key('input-qr-uri'),
                    controller: widget.qrUriController,
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontFamily: 'monospace',
                      color: _textPrimary,
                    ),
                    decoration: const InputDecoration(
                      hintText: 'nienie://pair?data=...',
                      hintStyle: TextStyle(
                        fontSize: 12.5,
                        fontFamily: 'monospace',
                        color: _textSecondary,
                      ),
                      border: InputBorder.none,
                      isDense: true,
                      contentPadding: EdgeInsets.symmetric(vertical: 8),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                SizedBox(
                  height: 36,
                  child: OutlinedButton.icon(
                    key: const Key('btn-pair-qr-uri'),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: _textPrimary,
                      side: const BorderSide(color: _btnBorderColor),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                    onPressed: () {
                      client.pairWithQrUri(widget.qrUriController.text);
                    },
                    icon: const Icon(LucideIcons.link, size: 14, color: _textSecondary),
                    label: Text(
                      s.pairWithQrBtn,
                      style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500),
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
