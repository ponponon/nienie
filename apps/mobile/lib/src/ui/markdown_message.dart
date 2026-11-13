import 'dart:async';

import 'package:flutter/material.dart';
import 'theme_colors.dart';
import 'package:flutter/services.dart';
import 'package:flutter_highlight/flutter_highlight.dart';
import 'package:flutter_highlight/themes/atom-one-dark.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import '../i18n/app_strings.dart';

const Color _weTypeGreen = Color(0xFF17B378);
const Color _codeBg = Color(0xFF17181C);
const Color _codeHeader = Color(0xFF22242B);
const Color _codeHeaderLabel = Color(0xFF9CA3AF);

/// 4.1：Markdown 渲染（含语法高亮代码块）+ 4.2：代码块复制按钮。
/// 仅用于 Agent 输出；用户气泡与思考过程保持纯文本。
class MarkdownMessage extends StatelessWidget {
  final String data;
  final NienieStrings strings;

  /// 4.1 链接点击回调（测试注入）；默认走 url_launcher 外部浏览器。
  final void Function(Uri url)? onOpenLink;

  const MarkdownMessage({
    super.key,
    required this.data,
    required this.strings,
    this.onOpenLink,
  });

  static Future<void> _defaultOpenLink(Uri url) async {
    // 外部浏览器启动失败不得成为未处理异步异常（无浏览器/被策略拦截等）
    try {
      await launchUrl(url, mode: LaunchMode.externalApplication);
    } catch (error, stackTrace) {
      debugPrint('Failed to open Markdown link: $error');
      debugPrintStack(stackTrace: stackTrace);
    }
  }

  @override
  Widget build(BuildContext context) {
    return MarkdownBody(
      data: data,
      selectable: false,
      extensionSet: md.ExtensionSet.gitHubWeb,
      // 4.1：链接可点击跳转——仅放行 http/https（拦截 javascript:/file: 等协议）
      onTapLink: (text, href, title) {
        final uri = Uri.tryParse(href ?? '');
        if (uri == null) return;
        if (uri.scheme != 'http' && uri.scheme != 'https') return;
        if (onOpenLink != null) {
          onOpenLink!(uri);
        } else {
          _defaultOpenLink(uri);
        }
      },
      builders: {
        'pre': _CodeBlockBuilder(strings),
      },
      styleSheet: MarkdownStyleSheet(
        p: TextStyle(
          color: primaryTextColor(context),
          fontSize: 14,
          height: 1.55,
        ),
        h1: TextStyle(
          color: primaryTextColor(context),
          fontSize: 20,
          height: 1.35,
          fontWeight: FontWeight.w700,
        ),
        h2: TextStyle(
          color: primaryTextColor(context),
          fontSize: 17.5,
          height: 1.35,
          fontWeight: FontWeight.w700,
        ),
        h3: TextStyle(
          color: primaryTextColor(context),
          fontSize: 15.5,
          height: 1.4,
          fontWeight: FontWeight.w600,
        ),
        h4: TextStyle(
          color: primaryTextColor(context),
          fontSize: 14.5,
          height: 1.4,
          fontWeight: FontWeight.w600,
        ),
        em: TextStyle(
          color: primaryTextColor(context),
          fontStyle: FontStyle.italic,
        ),
        strong: TextStyle(
          color: primaryTextColor(context),
          fontWeight: FontWeight.w700,
        ),
        a: TextStyle(
          color: _weTypeGreen,
          decoration: TextDecoration.underline,
        ),
        code: TextStyle(
          color: primaryTextColor(context),
          fontSize: 13,
          fontFamily: 'monospace',
          backgroundColor: chipBgColor(context),
        ),
        blockquote: TextStyle(
          color: secondaryTextColor(context),
          fontSize: 14,
          height: 1.55,
        ),
        blockquoteDecoration: BoxDecoration(
          border: Border(
            left: BorderSide(color: _weTypeGreen, width: 3),
          ),
        ),
        blockquotePadding: const EdgeInsets.only(left: 12),
        listBullet: TextStyle(
          color: secondaryTextColor(context),
          fontSize: 14,
        ),
        horizontalRuleDecoration: BoxDecoration(
          border: Border(
            top: BorderSide(color: Color(0x12000000), width: 1),
          ),
        ),
        // 代码块外观由自定义 builder 提供，清空默认 pre 包装的底色
        codeblockDecoration: BoxDecoration(),
      ),
    );
  }
}

/// 围栏代码块：暗色块 + 语言标签 + 复制按钮 + 语法高亮（atom-one-dark）
class _CodeBlockBuilder extends MarkdownElementBuilder {
  final NienieStrings strings;

  _CodeBlockBuilder(this.strings);

  @override
  bool isBlockElement() => true;

  @override
  Widget? visitText(md.Text text, TextStyle? preferredStyle) {
    // 占位：代码文本由 visitElementAfterWithContext 整体渲染；
    // 返回空 widget 防止 flutter_markdown 的 inline 缓冲因无 child 而泄漏
    // （builder.dart `_inlines.isEmpty` assert）
    return const SizedBox(width: 0, height: 0);
  }

  @override
  Widget visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    md.Element? codeEl;
    for (final child in element.children ?? const <md.Node>[]) {
      if (child is md.Element && child.tag == 'code') {
        codeEl = child;
        break;
      }
    }
    // markdown 围栏解析会给内容补一个尾换行——复制/展示都去掉它
    final raw = (codeEl?.textContent ?? element.textContent)
        .replaceFirst(RegExp(r'\n$'), '');
    String? language;
    final cls = codeEl?.attributes['class'];
    if (cls != null && cls.startsWith('language-')) {
      language = cls.substring('language-'.length);
    }
    return _CodeBlock(
      code: raw,
      language: language,
      strings: strings,
    );
  }
}

class _CodeBlock extends StatefulWidget {
  final String code;
  final String? language;
  final NienieStrings strings;

  const _CodeBlock({
    required this.code,
    required this.language,
    required this.strings,
  });

  @override
  State<_CodeBlock> createState() => _CodeBlockState();
}

class _CodeBlockState extends State<_CodeBlock> {
  bool _copied = false;
  Timer? _copyFeedbackTimer;

  @override
  void dispose() {
    _copyFeedbackTimer?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    _copyFeedbackTimer?.cancel(); // 连续点击：旧计时器不得提前清掉新反馈
    setState(() => _copied = true);
    _copyFeedbackTimer = Timer(const Duration(milliseconds: 1500), () {
      if (mounted) {
        setState(() => _copied = false);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('code-block'),
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        color: _codeBg,
        borderRadius: BorderRadius.circular(10),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          // 头部：语言标签 + 复制按钮（远程复制=核心动作）
          Container(
            color: _codeHeader,
            padding: const EdgeInsets.only(left: 12, right: 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    widget.language?.isNotEmpty == true ? widget.language! : 'code',
                    style: TextStyle(
                      color: _codeHeaderLabel,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Tooltip(
                  message: _copied
                      ? widget.strings.codeCopiedLabel
                      : widget.strings.copyCodeLabel,
                  child: IconButton(
                    key: const Key('btn-copy-code'),
                    onPressed: _copy,
                    iconSize: 15,
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                    icon: Icon(
                      _copied ? LucideIcons.check : LucideIcons.copy,
                      size: 15,
                      color: _copied ? _weTypeGreen : _codeHeaderLabel,
                    ),
                  ),
                ),
              ],
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
            child: HighlightView(
              widget.code,
              language: widget.language,
              theme: atomOneDarkTheme,
              textStyle: TextStyle(
                fontFamily: 'monospace',
                fontSize: 12.5,
                height: 1.55,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
