import 'package:flutter/material.dart';

/// 7.2：深色模式亮度映射——系统暗色下关键容器/文字不刺眼（浅色值=既有设计 token）。
bool isDark(BuildContext context) => Theme.of(context).brightness == Brightness.dark;

/// 页面背景
Color appBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF121212) : Colors.white;

/// 卡片/容器底
Color cardBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF1C1C1E) : const Color(0xFFF7F8FA);

/// 胶囊/输入区底
Color chipBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF2C2C2E) : const Color(0xFFF3F4F6);

/// 主文字
Color primaryTextColor(BuildContext context) =>
    isDark(context) ? const Color(0xFFE5E5EA) : const Color(0xFF141416);

/// 次级文字
Color secondaryTextColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF989BA3) : const Color(0xFF686C75);

/// 弱化文字
Color mutedTextColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF6C7077) : const Color(0xFF989CA5);

/// 描边
Color subtleBorderColor(BuildContext context) =>
    isDark(context) ? const Color(0x22FFFFFF) : const Color(0x12000000);
