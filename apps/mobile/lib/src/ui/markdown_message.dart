import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_highlight/flutter_highlight.dart';
import 'package:flutter_highlight/themes/atom-one-dark.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:markdown/markdown.dart' as md;

import '../i18n/app_strings.dart';

const Color _textPrimary = Color(0xFF141416);
const Color _textSecondary = Color(0xFF686C75);
const Color _weTypeGreen = Color(0xFF17B378);
const Color _codeBg = Color(0xFF17181C);
const Color _codeHeader = Color(0xFF22242B);
const Color _codeHeaderLabel = Color(0xFF9CA3AF);

/// 4.1：Markdown 渲染（含语法高亮代码块）+ 4.2：代码块复制按钮。
/// 仅用于 Agent 输出；用户气泡与思考过程保持纯文本。
class MarkdownMessage extends StatelessWidget {
  final String data;
  final NienieStrings strings;

  const MarkdownMessage({
    super.key,
    required this.data,
    required this.strings,
  });

  @override
  Widget build(BuildContext context) {
    return MarkdownBody(
      data: data,
      selectable: false,
      extensionSet: md.ExtensionSet.gitHubWeb,
      builders: {
        'pre': _CodeBlockBuilder(strings),
      },
      styleSheet: MarkdownStyleSheet(
        p: const TextStyle(
          color: _textPrimary,
          fontSize: 14,
          height: 1.55,
        ),
        h1: const TextStyle(
          color: _textPrimary,
          fontSize: 20,
          height: 1.35,
          fontWeight: FontWeight.w700,
        ),
        h2: const TextStyle(
          color: _textPrimary,
          fontSize: 17.5,
          height: 1.35,
          fontWeight: FontWeight.w700,
        ),
        h3: const TextStyle(
          color: _textPrimary,
          fontSize: 15.5,
          height: 1.4,
          fontWeight: FontWeight.w600,
        ),
        h4: const TextStyle(
          color: _textPrimary,
          fontSize: 14.5,
          height: 1.4,
          fontWeight: FontWeight.w600,
        ),
        em: const TextStyle(
          color: _textPrimary,
          fontStyle: FontStyle.italic,
        ),
        strong: const TextStyle(
          color: _textPrimary,
          fontWeight: FontWeight.w700,
        ),
        a: const TextStyle(
          color: _weTypeGreen,
          decoration: TextDecoration.underline,
        ),
        code: TextStyle(
          color: _textPrimary,
          fontSize: 13,
          fontFamily: 'monospace',
          backgroundColor: const Color(0xFFF3F4F6),
        ),
        blockquote: const TextStyle(
          color: _textSecondary,
          fontSize: 14,
          height: 1.55,
        ),
        blockquoteDecoration: const BoxDecoration(
          border: Border(
            left: BorderSide(color: _weTypeGreen, width: 3),
          ),
        ),
        blockquotePadding: const EdgeInsets.only(left: 12),
        listBullet: const TextStyle(
          color: _textSecondary,
          fontSize: 14,
        ),
        horizontalRuleDecoration: const BoxDecoration(
          border: Border(
            top: BorderSide(color: Color(0x12000000), width: 1),
          ),
        ),
        // 代码块外观由自定义 builder 提供，清空默认 pre 包装的底色
        codeblockDecoration: const BoxDecoration(),
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
    final raw = codeEl?.textContent ?? element.textContent;
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

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    setState(() => _copied = true);
    await Future<void>.delayed(const Duration(milliseconds: 1500));
    if (mounted) {
      setState(() => _copied = false);
    }
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
                    style: const TextStyle(
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
              textStyle: const TextStyle(
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
