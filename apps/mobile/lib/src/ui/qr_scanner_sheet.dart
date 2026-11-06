import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../state/mobile_bridge_client.dart';

class QrScannerSheet extends StatefulWidget {
  final MobileBridgeClient client;
  final void Function(String qrUri) onDetected;

  const QrScannerSheet({
    super.key,
    required this.client,
    required this.onDetected,
  });

  @override
  State<QrScannerSheet> createState() => _QrScannerSheetState();
}

class _QrScannerSheetState extends State<QrScannerSheet> {
  final MobileScannerController _controller = MobileScannerController();
  bool _handled = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.client.strings;
    return SafeArea(
      child: Container(
        height: 440,
        padding: const EdgeInsets.all(16),
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(LucideIcons.scanLine, size: 18, color: Color(0xFF17B378)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    s.scanQrBtn,
                    style: const TextStyle(
                      fontSize: 15.5,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF141416),
                    ),
                  ),
                ),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(LucideIcons.x, size: 18, color: Color(0xFF6E7178)),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              s.scanQrHint,
              style: const TextStyle(fontSize: 12, color: Color(0xFF6E7178)),
            ),
            const SizedBox(height: 12),
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(14),
                child: MobileScanner(
                  controller: _controller,
                  onDetect: (capture) {
                    if (_handled) return;
                    for (final barcode in capture.barcodes) {
                      final raw = barcode.rawValue?.trim();
                      if (raw != null && raw.startsWith('nienie://')) {
                        _handled = true;
                        Navigator.of(context).pop();
                        widget.onDetected(raw);
                        break;
                      }
                    }
                  },
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
