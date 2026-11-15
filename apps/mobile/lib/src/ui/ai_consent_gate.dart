import 'package:flutter/material.dart';

import '../i18n/app_strings.dart';
import '../storage/credential_store.dart';

/// App Review Guideline 5.1.2(i) 门禁：
/// 在把用户内容发送给第三方 AI 之前，必须清晰披露接收方与用途，并取得用户明确许可。
/// 同意结果持久化在 [DeviceCredentialStore]；未同意时远程控制功能不可用。
class AiConsentGate extends StatefulWidget {
  const AiConsentGate({
    super.key,
    required this.store,
    required this.language,
    required this.child,
  });

  final DeviceCredentialStore store;
  final AppLanguage language;
  final Widget child;

  @override
  State<AiConsentGate> createState() => _AiConsentGateState();
}

class _AiConsentGateState extends State<AiConsentGate> {
  static const Color _accent = Color(0xFF17B378);

  bool _checked = false;
  bool _accepted = false;
  bool _declined = false;

  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    final accepted = await widget.store.loadAiConsent();
    if (!mounted) return;
    setState(() {
      _accepted = accepted;
      _checked = true;
    });
  }

  Future<void> _agree() async {
    await widget.store.saveAiConsent(true);
    if (!mounted) return;
    setState(() {
      _accepted = true;
      _declined = false;
    });
  }

  Future<void> _decline() async {
    await widget.store.saveAiConsent(false);
    if (!mounted) return;
    setState(() => _declined = true);
  }

  TextStyle _body(bool dark) => TextStyle(
        fontSize: 15,
        height: 1.55,
        color: dark ? const Color(0xFFE6E6E8) : const Color(0xFF3C3C43),
      );

  @override
  Widget build(BuildContext context) {
    if (!_checked) {
      return const SizedBox.shrink();
    }
    if (_accepted) return widget.child;

    final s = NienieStrings(widget.language);
    final dark = Theme.of(context).brightness == Brightness.dark;
    final titleColor = dark ? Colors.white : const Color(0xFF141416);

    return Scaffold(
      backgroundColor: dark ? const Color(0xFF121212) : Colors.white,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 36, 24, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                s.aiConsentTitle,
                style: TextStyle(
                  fontSize: 22,
                  height: 1.35,
                  fontWeight: FontWeight.w600,
                  color: titleColor,
                ),
              ),
              const SizedBox(height: 18),
              Expanded(
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(s.aiConsentLead, style: _body(dark)),
                      const SizedBox(height: 18),
                      for (final bullet in s.aiConsentBullets) ...[
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Container(
                              margin: const EdgeInsets.only(top: 9, right: 12),
                              width: 6,
                              height: 6,
                              decoration: const BoxDecoration(
                                color: _accent,
                                shape: BoxShape.circle,
                              ),
                            ),
                            Expanded(child: Text(bullet, style: _body(dark))),
                          ],
                        ),
                        const SizedBox(height: 12),
                      ],
                      if (_declined) ...[
                        const SizedBox(height: 4),
                        Text(
                          s.aiConsentDeclinedNote,
                          style: _body(dark).copyWith(
                            color: dark
                                ? const Color(0xFFFFB4A8)
                                : const Color(0xFFB3261E),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              if (_declined) ...[
                SizedBox(
                  width: double.infinity,
                  height: 50,
                  child: FilledButton(
                    onPressed: () => setState(() => _declined = false),
                    style: FilledButton.styleFrom(
                      backgroundColor: _accent,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: Text(
                      s.aiConsentReviewBtn,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
              ] else ...[
                SizedBox(
                  width: double.infinity,
                  height: 50,
                  child: FilledButton(
                    onPressed: _agree,
                    style: FilledButton.styleFrom(
                      backgroundColor: _accent,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: Text(
                      s.aiConsentAgreeBtn,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
                SizedBox(
                  width: double.infinity,
                  child: TextButton(
                    onPressed: _decline,
                    child: Text(
                      s.aiConsentDeclineBtn,
                      style: TextStyle(
                        fontSize: 15,
                        color: dark
                            ? const Color(0xFF9E9EA3)
                            : const Color(0xFF6B6B70),
                      ),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
