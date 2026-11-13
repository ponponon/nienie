import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/protocol_models.dart';
import '../state/mobile_bridge_client.dart';
import 'agent_brand_logo.dart';
import 'qr_scanner_sheet.dart';

class KelivoWorkspaceDrawer extends StatefulWidget {
  final MobileBridgeClient client;
  final VoidCallback onCloseDrawer;
  final VoidCallback onOpenComputerSheet;

  const KelivoWorkspaceDrawer({
    super.key,
    required this.client,
    required this.onCloseDrawer,
    required this.onOpenComputerSheet,
  });

  @override
  State<KelivoWorkspaceDrawer> createState() => _KelivoWorkspaceDrawerState();
}

class _KelivoWorkspaceDrawerState extends State<KelivoWorkspaceDrawer> {
  final Set<String> _collapsedProjects = {};
  final Set<String> _expandedMoreProjects = {};

  static const Color _textPrimary = Color(0xFF141416);
  static const Color _textSecondary = Color(0xFF686C75);
  static const Color _textMuted = Color(0xFF989CA5);
  static const Color _accentGreen = Color(0xFF17B378);

  @override
  Widget build(BuildContext context) {
    final client = widget.client;
    final machineName = client.activeMachineId ??
        (client.savedMachines.isNotEmpty
            ? client.savedMachines.first.machineId
            : 'MacBook Pro M5');
    final projectGroups = client.projectsForAgent(client.selectedAgentId);
    final selectedAgent = client.selectedAgentInfo;
    final isSelectedAgentAvailable = selectedAgent?.available ?? true;
    final onlineComputersCount = client.connectedMachineIds.isEmpty
        ? 1
        : client.connectedMachineIds.length;

    return Drawer(
      width: 310,
      backgroundColor: Colors.white,
      surfaceTintColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.horizontal(right: Radius.circular(20)),
      ),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Level 1: Top Computer Selector (MacBook Pro M5 v)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 14, 8),
              child: InkWell(
                borderRadius: BorderRadius.circular(10),
                onTap: widget.onOpenComputerSheet,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
                  child: Row(
                    children: [
                      Stack(
                        clipBehavior: Clip.none,
                        children: [
                          const Icon(
                            LucideIcons.monitor,
                            size: 20,
                            color: _textPrimary,
                          ),
                          Positioned(
                            top: -2,
                            right: -2,
                            child: Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: _accentGreen,
                                shape: BoxShape.circle,
                                border: Border.all(color: Colors.white, width: 1.5),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Row(
                          children: [
                            Flexible(
                              child: Text(
                                machineName,
                                style: const TextStyle(
                                  fontSize: 17.5,
                                  fontWeight: FontWeight.w700,
                                  letterSpacing: -0.3,
                                  color: _textPrimary,
                                ),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            const SizedBox(width: 4),
                            const Icon(
                              LucideIcons.chevronDown,
                              size: 16,
                              color: _textSecondary,
                            ),
                          ],
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 2.5,
                        ),
                        decoration: BoxDecoration(
                          color: _accentGreen.withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          '$onlineComputersCount 台在线',
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                            color: _accentGreen,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),

            // Level 2: Agent Selector Strip for the Current Computer
            if (client.agents.isNotEmpty)
              SizedBox(
                height: 40,
                child: ListView.separated(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  scrollDirection: Axis.horizontal,
                  itemCount: client.agents.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 6),
                  itemBuilder: (context, index) {
                    final agent = client.agents[index];
                    final isSelected = client.selectedAgentId == agent.id;
                    return InkWell(
                      key: Key('chip-agent-${agent.id}'),
                      borderRadius: BorderRadius.circular(10),
                      onTap: () => client.selectAgent(agent.id),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(
                          color: isSelected ? Colors.white : const Color(0xFFF5F6F8),
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(
                            color: isSelected
                                ? const Color(0x22000000)
                                : Colors.transparent,
                          ),
                          boxShadow: isSelected
                              ? const [
                                  BoxShadow(
                                    color: Color(0x0A000000),
                                    blurRadius: 6,
                                    offset: Offset(0, 2),
                                  ),
                                ]
                              : null,
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            AgentBrandLogo(agentId: agent.id, size: 13),
                            const SizedBox(width: 6),
                            Text(
                              agent.name,
                              style: TextStyle(
                                fontSize: 12.5,
                                fontWeight:
                                    isSelected ? FontWeight.w600 : FontWeight.w500,
                                color: isSelected ? _textPrimary : _textSecondary,
                              ),
                            ),
                            if (agent.available) ...[
                              const SizedBox(width: 4),
                              Container(
                                width: 5,
                                height: 5,
                                decoration: const BoxDecoration(
                                  color: _accentGreen,
                                  shape: BoxShape.circle,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),

            const SizedBox(height: 12),

            // Full-Width "新建任务" Pill Button
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: SizedBox(
                height: 40,
                child: OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: _textPrimary,
                    side: const BorderSide(color: Color(0x18000000)),
                    shape: const StadiumBorder(),
                  ),
                  onPressed: !isSelectedAgentAvailable
                      ? null
                      : () async {
                          final targetAgent = client.selectedAgentId;
                          final defaultPath = projectGroups.isNotEmpty
                              ? projectGroups.first.projectPath
                              : null;
                          await client.createSession(
                            agentId: targetAgent,
                            title: '新对话',
                            projectPath: defaultPath,
                          );
                          widget.onCloseDrawer();
                        },
                  icon: const Icon(LucideIcons.messageSquarePlus, size: 16),
                  label: Text(
                    isSelectedAgentAvailable
                        ? '新建任务'
                        : '${selectedAgent?.name ?? "该助手"} 未安装',
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ),

            const SizedBox(height: 16),

            // Level 3: Workspaces / Projects Tree Header ("空间 (N) v")
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 18),
              child: Row(
                children: [
                  Text(
                    '空间 (${projectGroups.length})',
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: _textSecondary,
                    ),
                  ),
                  const SizedBox(width: 4),
                  const Icon(
                    LucideIcons.chevronDown,
                    size: 13,
                    color: _textSecondary,
                  ),
                ],
              ),
            ),

            const SizedBox(height: 6),

            // Project Folder Tree + Sessions List
            Expanded(
              child: projectGroups.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 24),
                        child: Text(
                          isSelectedAgentAvailable
                              ? '暂无历史项目会话'
                              : '这台电脑尚未安装 ${selectedAgent?.name ?? client.selectedAgentId}',
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 13,
                            color: _textMuted,
                          ),
                        ),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.fromLTRB(12, 2, 12, 16),
                      itemCount: projectGroups.length,
                      itemBuilder: (context, idx) {
                  final group = projectGroups[idx];
                  final isCollapsed = _collapsedProjects.contains(group.projectPath);
                  final showAll = _expandedMoreProjects.contains(group.projectPath);
                  final visibleSessions = showAll
                      ? group.sessions
                      : group.sessions.take(5).toList();
                  final hasMore = !showAll && group.sessions.length > 5;

                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // Folder Row: 📁 nienie   v  +
                      InkWell(
                        borderRadius: BorderRadius.circular(10),
                        onTap: () {
                          setState(() {
                            if (isCollapsed) {
                              _collapsedProjects.remove(group.projectPath);
                            } else {
                              _collapsedProjects.add(group.projectPath);
                            }
                          });
                        },
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 8,
                          ),
                          child: Row(
                            children: [
                              const Icon(
                                LucideIcons.folder,
                                size: 17,
                                color: _textPrimary,
                              ),
                              const SizedBox(width: 9),
                              Expanded(
                                child: Text(
                                  group.projectName,
                                  style: const TextStyle(
                                    fontSize: 15,
                                    fontWeight: FontWeight.w600,
                                    color: _textPrimary,
                                  ),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                              Icon(
                                isCollapsed
                                    ? LucideIcons.chevronRight
                                    : LucideIcons.chevronDown,
                                size: 15,
                                color: _textMuted,
                              ),
                              const SizedBox(width: 8),
                              GestureDetector(
                                onTap: () async {
                                  await client.createSession(
                                    agentId: client.selectedAgentId,
                                    title: '${group.projectName} 新任务',
                                    projectPath: group.projectPath,
                                  );
                                  widget.onCloseDrawer();
                                },
                                child: const Padding(
                                  padding: EdgeInsets.all(2),
                                  child: Icon(
                                    LucideIcons.plus,
                                    size: 16,
                                    color: _textSecondary,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),

                      // Sessions under this project folder
                      if (!isCollapsed)
                        Padding(
                          padding: const EdgeInsets.only(left: 26, bottom: 6),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              for (final session in visibleSessions)
                                _buildSessionItem(client, session),
                              if (hasMore)
                                InkWell(
                                  borderRadius: BorderRadius.circular(8),
                                  onTap: () {
                                    setState(() {
                                      _expandedMoreProjects.add(group.projectPath);
                                    });
                                  },
                                  child: const Padding(
                                    padding: EdgeInsets.symmetric(
                                      horizontal: 8,
                                      vertical: 6,
                                    ),
                                    child: Text(
                                      '查看更多',
                                      style: TextStyle(
                                        fontSize: 12.5,
                                        color: _textMuted,
                                      ),
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                    ],
                  );
                },
              ),
            ),

            // Drawer Footer: Disconnect / Switch Computer
            Container(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
              decoration: const BoxDecoration(
                border: Border(top: BorderSide(color: Color(0x12000000))),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  TextButton.icon(
                    onPressed: widget.onOpenComputerSheet,
                    icon: const Icon(LucideIcons.laptop, size: 15, color: _textSecondary),
                    label: const Text(
                      '管理已连接电脑',
                      style: TextStyle(fontSize: 12.5, color: _textSecondary),
                    ),
                  ),
                  TextButton.icon(
                    onPressed: () {
                      widget.onCloseDrawer();
                      client.disconnect();
                    },
                    icon: const Icon(
                      LucideIcons.unplug,
                      size: 14,
                      color: Color(0xFFDC2626),
                    ),
                    label: const Text(
                      '断开',
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w500,
                        color: Color(0xFFDC2626),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSessionItem(MobileBridgeClient client, AgentSession session) {
    final isSelected = client.activeSession?.id == session.id;
    final unread = client.isSessionUnread(session.id) && !isSelected;
    // 6.1：标题 · 项目 · 相对时间 · 状态点 · 未读标记
    final projectName = session.projectPath.isNotEmpty
        ? session.projectPath.split('/').where((s) => s.isNotEmpty).lastOrNull ?? ''
        : '';
    // Round2：实时状态（events 驱动），不读静态模型字段
    final liveStatus = client.statusFor(session.id);
    // Round2：活动时间随会话实际活动更新（本地乐观时间，权威时间到达后自然更旧/更新）
    final modelTime = session.updatedAt ?? session.createdAt;
    final lastActivity = client.lastActivityFor(session.id);
    final time = (modelTime != null && lastActivity != null && modelTime.isAfter(lastActivity))
        ? modelTime
        : (lastActivity ?? modelTime);
    return InkWell(
      key: Key('session-item-${session.id}'),
      borderRadius: BorderRadius.circular(9),
      onTap: () async {
        await client.openSession(session);
        widget.onCloseDrawer();
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        margin: const EdgeInsets.only(bottom: 2),
        decoration: BoxDecoration(
          color: isSelected ? const Color(0xFFF2F4F7) : Colors.transparent,
          borderRadius: BorderRadius.circular(9),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                // 状态点（运行中/idle）
                Container(
                  key: Key('session-status-dot-${session.id}'),
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: liveStatus == 'running' ? _accentGreen : _textMuted,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    session.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: isSelected ? FontWeight.w600 : FontWeight.w400,
                      color: isSelected ? _textPrimary : const Color(0xFF2C2E33),
                    ),
                  ),
                ),
                if (unread)
                  Container(
                    key: Key('unread-dot-${session.id}'),
                    width: 8,
                    height: 8,
                    decoration: const BoxDecoration(
                      color: Color(0xFFEF4444),
                      shape: BoxShape.circle,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 3),
            Text(
              [
                if (projectName.isNotEmpty) projectName,
                if (time != null) client.strings.relativeTime(time),
              ].join(' · '),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 11.5,
                color: _textMuted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

void showMultiComputerSheet({
  required BuildContext context,
  required MobileBridgeClient client,
  required TextEditingController wsUrlController,
  required TextEditingController pairingCodeController,
  required TextEditingController qrUriController,
}) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (sheetCtx) {
      return Container(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 28),
        decoration: const BoxDecoration(
          color: Color(0xFFF8F9FA),
          borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
        ),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 14),
                  decoration: BoxDecoration(
                    color: const Color(0xFFD1D5DB),
                    borderRadius: BorderRadius.circular(999),
                  ),
                ),
              ),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text(
                    '已连接的电脑 (支持多台切换)',
                    style: TextStyle(
                      fontSize: 15.5,
                      fontWeight: FontWeight.w700,
                      color: Color(0xFF141416),
                    ),
                  ),
                  TextButton.icon(
                    onPressed: () {
                      Navigator.of(sheetCtx).pop();
                      showModalBottomSheet<void>(
                        context: context,
                        isScrollControlled: true,
                        backgroundColor: Colors.transparent,
                        builder: (_) => QrScannerSheet(
                          client: client,
                          onDetected: (rawUri) {
                            qrUriController.text = rawUri;
                            client.pairWithQrUri(rawUri);
                          },
                        ),
                      );
                    },
                    icon: const Icon(
                      LucideIcons.scanLine,
                      size: 14,
                      color: Color(0xFF17B378),
                    ),
                    label: const Text(
                      '扫码添加新电脑',
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF17B378),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: const Color(0x12000000)),
                ),
                child: Column(
                  children: [
                    if (client.savedMachines.isEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        child: Text(
                          client.activeMachineId ?? 'MacBook-Pro-M5 (当前在线)',
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    for (int i = 0; i < client.savedMachines.length; i++) ...[
                      if (i > 0)
                        const Divider(height: 1, color: Color(0x12000000)),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Row(
                          children: [
                            Container(
                              width: 36,
                              height: 36,
                              decoration: BoxDecoration(
                                color: const Color(0xFF17B378).withValues(alpha: 0.1),
                                borderRadius: BorderRadius.circular(10),
                              ),
                              alignment: Alignment.center,
                              child: const Icon(
                                LucideIcons.monitor,
                                size: 18,
                                color: Color(0xFF17B378),
                              ),
                            ),
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
                                      color: Color(0xFF141416),
                                    ),
                                  ),
                                  Text(
                                    client.savedMachines[i].wsUrl,
                                    style: const TextStyle(
                                      fontSize: 11.5,
                                      fontFamily: 'monospace',
                                      color: Color(0xFF686C75),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            if (client.activeMachineId ==
                                client.savedMachines[i].machineId)
                              const Text(
                                '● 当前激活',
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600,
                                  color: Color(0xFF17B378),
                                ),
                              )
                            else
                              OutlinedButton(
                                onPressed: () {
                                  Navigator.of(sheetCtx).pop();
                                  client.reconnectWithSavedCredential(
                                    client.savedMachines[i].machineId,
                                  );
                                },
                                child: const Text('切换', style: TextStyle(fontSize: 12)),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}
