export type DesktopLocale = 'zh' | 'en' | 'ja' | 'ko';

export type DesktopTranslation = {
  appTitle: string;
  navPair: string;
  navAgents: string;
  navNetwork: string;
  navSystem: string;
  navAbout: string;
  autoUpdateTitle: string;
  autoUpdateDesc: string;
  feedbackTitle: string;
  feedbackDesc: string;
  copyDiagBtn: string;
  appreciateTitle: string;
  appreciateDesc: string;
  copyrightOwner: string;
  termsLink: string;
  privacyLink: string;
  termsContent: string;
  privacyContent: string;
  closeBtn: string;
  heroTitle: string;
  heroSubtitle: string;
  localBridge: string;
  bridgeDesc: string;
  startBridge: string;
  stopBridge: string;
  localAgents: string;
  agentsDesc: string;
  detect: string;
  detecting: string;
  mobilePairing: string;
  newCode: string;
  pairingCodeLabel: string;
  pairingCodeDesc: string;
  copyUriBtn: string;
  copiedText: string;
  machineLabel: string;
  machineDesc: string;
  saveMachineBtn: string;
  endpointLabel: string;
  connectedDevicesLabel: string;
  connectedDevicesDesc: string;
  noDevicesDesc: string;
  detectedBadge: string;
  unavailableBadge: string;
  moreAgentsSummary: string;
  publicRelay: string;
  relayDefaultTitle: string;
  relayDefaultDesc: string;
  relayCustomTitle: string;
  relayCustomDesc: string;
  useCustomRelay: string;
  useDefaultRelay: string;
  languageTitle: string;
  languageDesc: string;
  diagnosticLogs: string;
  logsDesc: string;
  clearFilterText: string;
  running: string;
  stopped: string;
  error: string;
  revokeBtn: string;
  revokedBadge: string;
  toastSaved: string;
  toastBridgeStarted: string;
  toastBridgeStopped: string;
  toastAgentsRefreshed: string;
  toastCodeRefreshed: string;
  toastDeviceRevoked: string;
};

export const DESKTOP_I18N: Record<DesktopLocale, DesktopTranslation> = {
  zh: {
    appTitle: 'Nienie Bridge 控制台',
    navPair: '手机连接',
    navAgents: 'AI 助手',
    navNetwork: '跨设备网络',
    navSystem: '偏好与日志',
    navAbout: '升级和反馈',
    autoUpdateTitle: '有新版本时自动更新',
    autoUpdateDesc: '在后台静默下载并安装最新稳定版桌面控制台',
    feedbackTitle: '我要反馈',
    feedbackDesc: '遇到问题或有功能建议？可一键复制脱敏诊断摘要提交反馈',
    copyDiagBtn: '复制诊断反馈包',
    appreciateTitle: '赞赏与支持作者',
    appreciateDesc: '如果 Nienie 帮您提升了开发效率，欢迎微信扫码赞赏支持持续迭代',
    copyrightOwner: 'ponponon 版权所有',
    termsLink: '用户协议',
    privacyLink: '隐私政策',
    termsContent:
      'Nienie 是面向开发者的本地 AI 编程 Agent 移动控制台。所有 Agent 会话、工具执行与代码修改均在您本人授权的电脑本地完成，请妥善保管配对凭据并仅信任您本人的移动设备。',
    privacyContent:
      'Nienie 严守本地优先与端到端加密（AES-256-GCM）原则：绝不收集或上传您的 Agent API Key、环境变量或源代码；诊断日志均经过自动脱敏处理。',
    closeBtn: '关闭',
    heroTitle: '手机扫码连接',
    heroSubtitle: '打开手机 Nienie 扫描二维码，自动绑定这台 Mac',
    localBridge: '本地 Bridge',
    bridgeDesc: '开启后允许手机通过局域网或 USB 连接这台电脑',
    startBridge: '启动服务',
    stopBridge: '停止服务',
    localAgents: '本机 AI 助手',
    agentsDesc: '已自动检测这台 Mac 上安装的编程 Agent',
    detect: '重新检测',
    detecting: '检测中',
    mobilePairing: '手机连接',
    newCode: '更换配对码',
    pairingCodeLabel: '6 位数字配对码',
    pairingCodeDesc: '如果不方便扫码，可在手机端直接输入此数字连接',
    copyUriBtn: '复制连接口令',
    copiedText: '已复制到剪贴板',
    machineLabel: '本机名称',
    machineDesc: '手机连接时显示的电脑名称，默认读取系统主机名',
    saveMachineBtn: '保存',
    endpointLabel: '监听地址',
    connectedDevicesLabel: '已连接手机',
    connectedDevicesDesc: '管理已授权访问这台 Mac 的移动设备',
    noDevicesDesc: '暂未绑定手机，使用手机扫描上方二维码即可完成配对',
    detectedBadge: '已就绪',
    unavailableBadge: '未安装',
    moreAgentsSummary: '显示其他未安装的扩展助手',
    publicRelay: '跨设备网络',
    relayDefaultTitle: '使用默认公网中继',
    relayDefaultDesc: '不在同一 Wi-Fi 时，通过加密中继服务自动穿透连接',
    relayCustomTitle: '自定义中继服务器',
    relayCustomDesc: '使用您自己部署的私有 WebSocket Relay 地址',
    useCustomRelay: '保存并应用',
    useDefaultRelay: '恢复默认',
    languageTitle: '界面语言',
    languageDesc: '设置桌面端控制台的显示语言',
    diagnosticLogs: '运行诊断日志',
    logsDesc: '最近服务状态与脱敏事件记录',
    clearFilterText: '全部日志',
    running: '运行中',
    stopped: '已停止',
    error: '异常',
    revokeBtn: '移除',
    revokedBadge: '已移除',
    toastSaved: '设置已保存并立即生效',
    toastBridgeStarted: '本地 Bridge 服务已启动',
    toastBridgeStopped: '本地 Bridge 服务已停止',
    toastAgentsRefreshed: '本机 AI 助手状态已更新',
    toastCodeRefreshed: '已生成新的 6 位配对码',
    toastDeviceRevoked: '已移除该移动设备的访问权限',
  },
  en: {
    appTitle: 'Nienie Bridge Console',
    navPair: 'Phone Pairing',
    navAgents: 'AI Agents',
    navNetwork: 'Network & Relay',
    navSystem: 'Preferences',
    navAbout: 'Update & Feedback',
    autoUpdateTitle: 'Automatically install updates',
    autoUpdateDesc: 'Download and install the latest stable release in the background',
    feedbackTitle: 'Send Feedback',
    feedbackDesc: 'Copy redacted diagnostic summary to report an issue or suggestion',
    copyDiagBtn: 'Copy Diagnostic Report',
    appreciateTitle: 'Support the Developer',
    appreciateDesc: 'If Nienie improves your workflow, scan via WeChat to buy me a coffee',
    copyrightOwner: 'Created by ponponon',
    termsLink: 'Terms of Use',
    privacyLink: 'Privacy Policy',
    termsContent:
      'Nienie is a local-first mobile control console for AI coding agents. All agent execution and code modifications occur locally on your authorized computer.',
    privacyContent:
      'Nienie enforces end-to-end encryption (AES-256-GCM) and local credential isolation. Your API keys, environment variables, and source code are never uploaded to third parties.',
    closeBtn: 'Close',
    heroTitle: 'Scan QR Code with Phone',
    heroSubtitle: 'Open Nienie on your phone and scan to pair with this Mac',
    localBridge: 'Local Bridge',
    bridgeDesc: 'Allow mobile devices to connect over LAN or USB',
    startBridge: 'Start',
    stopBridge: 'Stop',
    localAgents: 'Local AI Agents',
    agentsDesc: 'Coding agents detected on this computer',
    detect: 'Refresh',
    detecting: 'Scanning',
    mobilePairing: 'Phone Pairing',
    newCode: 'Refresh Code',
    pairingCodeLabel: '6-Digit Pairing Code',
    pairingCodeDesc: 'Enter this code on your phone if camera scanning is unavailable',
    copyUriBtn: 'Copy Pairing Link',
    copiedText: 'Copied to clipboard',
    machineLabel: 'Computer Name',
    machineDesc: 'Display name shown on paired phones (defaults to system hostname)',
    saveMachineBtn: 'Save',
    endpointLabel: 'Local Endpoint',
    connectedDevicesLabel: 'Paired Phones',
    connectedDevicesDesc: 'Manage mobile devices authorized for this Mac',
    noDevicesDesc: 'No phones paired yet. Scan the QR code above with your phone to pair.',
    detectedBadge: 'Ready',
    unavailableBadge: 'Not Installed',
    moreAgentsSummary: 'Show other uninstalled agents',
    publicRelay: 'Network & Relay',
    relayDefaultTitle: 'Default Public Relay',
    relayDefaultDesc: 'Connect across networks via end-to-end encrypted relay',
    relayCustomTitle: 'Custom Relay Server',
    relayCustomDesc: 'Use your own self-hosted WebSocket Relay endpoint',
    useCustomRelay: 'Apply',
    useDefaultRelay: 'Reset',
    languageTitle: 'Language',
    languageDesc: 'Choose display language for desktop console',
    diagnosticLogs: 'Diagnostic Logs',
    logsDesc: 'Recent service activity and redacted event logs',
    clearFilterText: 'All Logs',
    running: 'Running',
    stopped: 'Stopped',
    error: 'Error',
    revokeBtn: 'Revoke',
    revokedBadge: 'Revoked',
    toastSaved: 'Preferences saved',
    toastBridgeStarted: 'Local Bridge started',
    toastBridgeStopped: 'Local Bridge stopped',
    toastAgentsRefreshed: 'Agent detection updated',
    toastCodeRefreshed: 'Generated new 6-digit pairing code',
    toastDeviceRevoked: 'Device access revoked',
  },
  ja: {
    appTitle: 'Nienie Bridge コンソール',
    navPair: 'スマホ接続',
    navAgents: 'AI アシスタント',
    navNetwork: 'ネットワーク',
    navSystem: '環境設定',
    navAbout: 'アップデートとフィードバック',
    autoUpdateTitle: '新しいバージョンを自動更新',
    autoUpdateDesc: 'バックグラウンドで最新バージョンを自動的にダウンロードして適用します',
    feedbackTitle: 'フィードバックを送る',
    feedbackDesc: '診断サマリーをコピーして不具合の報告や要望を送信できます',
    copyDiagBtn: '診断レポートをコピー',
    appreciateTitle: '開発者を応援する',
    appreciateDesc: 'Nienie が役立ったら WeChat で開発をサポートしていただけると嬉しいです',
    copyrightOwner: 'ponponon All Rights Reserved',
    termsLink: '利用規約',
    privacyLink: 'プライバシーポリシー',
    termsContent:
      'Nienie はローカル AI コーディングエージェント用のモバイルコンソールです。すべてのエージェント実行はお使いの Mac 上で行われます。',
    privacyContent:
      'API キーや環境変数がスマホや外部サーバーに送信されることはありません。リモート通信は AES-256-GCM で暗号化されます。',
    closeBtn: '閉じる',
    heroTitle: 'QR コードでスマホ接続',
    heroSubtitle: 'スマホの Nienie アプリでスキャンしてこの Mac とペアリングします',
    localBridge: 'ローカル Bridge',
    bridgeDesc: 'LAN または USB 経由でのスマホ接続を許可します',
    startBridge: '起動',
    stopBridge: '停止',
    localAgents: 'ローカル AI',
    agentsDesc: 'この Mac で検出されたコーディングエージェント',
    detect: '再検出',
    detecting: '検出中',
    mobilePairing: 'スマホ接続',
    newCode: 'コード更新',
    pairingCodeLabel: '6桁のペアリングコード',
    pairingCodeDesc: 'カメラが使えない場合はスマホでこの番号を入力してください',
    copyUriBtn: 'リンクをコピー',
    copiedText: 'コピーしました',
    machineLabel: 'コンピュータ名',
    machineDesc: 'スマホ側に表示されるこの Mac の名前（初期値はホスト名）',
    saveMachineBtn: '保存',
    endpointLabel: 'ローカルアドレス',
    connectedDevicesLabel: 'ペアリング済み端末',
    connectedDevicesDesc: 'この Mac へのアクセスを許可したスマホを管理します',
    noDevicesDesc: 'まだペアリングされた端末はありません。上の QR コードをスキャンしてください。',
    detectedBadge: '準備完了',
    unavailableBadge: '未検出',
    moreAgentsSummary: '未インストールのエージェントを表示',
    publicRelay: 'ネットワーク設定',
    relayDefaultTitle: '標準パブリック Relay',
    relayDefaultDesc: '外出先からでも暗号化中継で安全に接続します',
    relayCustomTitle: 'カスタム Relay サーバー',
    relayCustomDesc: '独自の WebSocket Relay アドレスを指定します',
    useCustomRelay: '適用',
    useDefaultRelay: '標準に戻す',
    languageTitle: '表示言語',
    languageDesc: 'コンソールの表示言語を切り替えます',
    diagnosticLogs: '診断ログ',
    logsDesc: 'サービスの状態とイベント履歴',
    clearFilterText: 'すべて',
    running: '実行中',
    stopped: '停止中',
    error: 'エラー',
    revokeBtn: '解除',
    revokedBadge: '解除済',
    toastSaved: '設定を保存しました',
    toastBridgeStarted: 'ローカル Bridge を起動しました',
    toastBridgeStopped: 'ローカル Bridge を停止しました',
    toastAgentsRefreshed: 'エージェント状態を更新しました',
    toastCodeRefreshed: '新しいペアリングコードを生成しました',
    toastDeviceRevoked: '端末のアクセス権を解除しました',
  },
  ko: {
    appTitle: 'Nienie Bridge 콘솔',
    navPair: '휴대폰 연결',
    navAgents: 'AI 에이전트',
    navNetwork: '네트워크 설정',
    navSystem: '환경설정',
    navAbout: '업데이트 및 피드백',
    autoUpdateTitle: '새 버전 자동 업데이트',
    autoUpdateDesc: '백그라운드에서 최신 안정 버전을 자동으로 다운로드하고 설치합니다',
    feedbackTitle: '피드백 보내기',
    feedbackDesc: '진단 요약을 복사하여 버그 리포트나 기능 제안을 보내주세요',
    copyDiagBtn: '진단 리포트 복사',
    appreciateTitle: '개발자 후원하기',
    appreciateDesc: 'Nienie가 도움이 되었다면 WeChat 스캔으로 개발자를 응원해 주세요',
    copyrightOwner: 'ponponon 판권 소유',
    termsLink: '이용약관',
    privacyLink: '개인정보 처리방침',
    termsContent:
      'Nienie는 로컬 AI 코딩 에이전트를 제어하기 위한 모바일 콘솔입니다. 모든 코드 실행과 에이전트 작업은 사용자의 컴퓨터에서 안전하게 처리됩니다.',
    privacyContent:
      'API 키와 환경 변수는 외부로 전송되지 않으며, 릴레이 구간의 모든 데이터는 AES-256-GCM으로 종단간 암호화됩니다.',
    closeBtn: '닫기',
    heroTitle: 'QR 코드로 휴대폰 연결',
    heroSubtitle: '휴대폰 Nienie 앱으로 스캔하여 이 Mac과 연결합니다',
    localBridge: '로컬 Bridge',
    bridgeDesc: 'LAN 또는 USB를 통한 휴대폰 연결을 허용합니다',
    startBridge: '시작',
    stopBridge: '중지',
    localAgents: '로컬 AI 에이전트',
    agentsDesc: '이 Mac에서 감지된 코딩 에이전트',
    detect: '다시 감지',
    detecting: '감지 중',
    mobilePairing: '휴대폰 연결',
    newCode: '새 코드',
    pairingCodeLabel: '6자리 페어링 코드',
    pairingCodeDesc: '카메라 스캔이 어려울 경우 휴대폰에 이 번호를 입력하세요',
    copyUriBtn: '연결 링크 복사',
    copiedText: '클립보드에 복사됨',
    machineLabel: '컴퓨터 이름',
    machineDesc: '휴대폰 연결 시 표시되는 컴퓨터 이름 (기본값: 시스템 호스트명)',
    saveMachineBtn: '저장',
    endpointLabel: '로컬 주소',
    connectedDevicesLabel: '연결된 휴대폰',
    connectedDevicesDesc: '이 Mac에 접근 권한이 있는 모바일 기기 관리',
    noDevicesDesc: '연결된 휴대폰이 없습니다. 위 QR 코드를 스캔하여 연결하세요.',
    detectedBadge: '준비됨',
    unavailableBadge: '미설치',
    moreAgentsSummary: '설치되지 않은 다른 에이전트 보기',
    publicRelay: '네트워크 및 Relay',
    relayDefaultTitle: '기본 퍼블릭 Relay 사용',
    relayDefaultDesc: '외부 네트워크에서도 암호화 릴레이로 자동 연결합니다',
    relayCustomTitle: '사용자 지정 Relay 서버',
    relayCustomDesc: '직접 구축한 프라이빗 WebSocket Relay 주소를 사용합니다',
    useCustomRelay: '적용',
    useDefaultRelay: '기본값 복원',
    languageTitle: '표시 언어',
    languageDesc: '데스크톱 콘솔의 표시 언어를 설정합니다',
    diagnosticLogs: '진단 로그',
    logsDesc: '최근 서비스 상태 및 이벤트 기록',
    clearFilterText: '전체 로그',
    running: '실행 중',
    stopped: '중지됨',
    error: '오류',
    revokeBtn: '해제',
    revokedBadge: '해제됨',
    toastSaved: '설정이 저장되었습니다',
    toastBridgeStarted: '로컬 Bridge가 시작되었습니다',
    toastBridgeStopped: '로컬 Bridge가 중지되었습니다',
    toastAgentsRefreshed: '에이전트 상태가 업데이트되었습니다',
    toastCodeRefreshed: '새로운 페어링 코드가 생성되었습니다',
    toastDeviceRevoked: '기기 연결 권한이 해제되었습니다',
  },
};
