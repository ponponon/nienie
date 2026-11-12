enum AppLanguage { zh, en, ja, ko }

class NienieStrings {
  final AppLanguage lang;
  const NienieStrings(this.lang);

  String get appTitle => switch (lang) {
        AppLanguage.zh => 'Nienie 控制台',
        AppLanguage.en => 'Nienie Console',
        AppLanguage.ja => 'Nienie コンソール',
        AppLanguage.ko => 'Nienie 콘솔',
      };

  String get statusConnected => switch (lang) {
        AppLanguage.zh => '已连接',
        AppLanguage.en => 'Connected',
        AppLanguage.ja => '接続済み',
        AppLanguage.ko => '연결됨',
      };

  String get statusConnecting => switch (lang) {
        AppLanguage.zh => '连接中',
        AppLanguage.en => 'Connecting',
        AppLanguage.ja => '接続中',
        AppLanguage.ko => '연결 중',
      };

  String get statusError => switch (lang) {
        AppLanguage.zh => '错误',
        AppLanguage.en => 'Error',
        AppLanguage.ja => 'エラー',
        AppLanguage.ko => '오류',
      };

  String get statusDisconnected => switch (lang) {
        AppLanguage.zh => '未连接',
        AppLanguage.en => 'Disconnected',
        AppLanguage.ja => '未接続',
        AppLanguage.ko => '연결 안 됨',
      };

  String get connectTitle => switch (lang) {
        AppLanguage.zh => '连接电脑 Bridge',
        AppLanguage.en => 'Connect to Computer Bridge',
        AppLanguage.ja => 'PC Bridge に接続',
        AppLanguage.ko => '컴퓨터 Bridge 연결',
      };

  String get scanQrBtn => switch (lang) {
        AppLanguage.zh => '扫码连接电脑',
        AppLanguage.en => 'Scan QR Code to Connect',
        AppLanguage.ja => 'QR コードをスキャンして接続',
        AppLanguage.ko => 'QR 코드 스캔하여 연결',
      };

  String get scanQrHint => switch (lang) {
        AppLanguage.zh => '对准电脑二维码即可自动配对',
        AppLanguage.en => 'Point camera at desktop QR code',
        AppLanguage.ja => 'PCのQRコードをスキャン',
        AppLanguage.ko => '컴퓨터 QR 코드를 스캔하세요',
      };

  String get emptyPairingCodeError => switch (lang) {
        AppLanguage.zh => '请先输入 6 位配对码，或点击上方「扫码连接电脑」',
        AppLanguage.en => 'Please enter the 6-digit pairing code or scan the QR code',
        AppLanguage.ja => '6桁のペアリングコードを入力するか、QRコードをスキャンしてください',
        AppLanguage.ko => '6자리 페어링 코드를 입력하거나 QR 코드를 스캔하세요',
      };

  String get wsUrlLabel => switch (lang) {
        AppLanguage.zh => 'Bridge WebSocket 地址',
        AppLanguage.en => 'Bridge WebSocket URL',
        AppLanguage.ja => 'Bridge WebSocket URL',
        AppLanguage.ko => 'Bridge WebSocket 주소',
      };

  String get pairingCodeLabel => switch (lang) {
        AppLanguage.zh => '一次性配对码 (6位)',
        AppLanguage.en => 'One-Time Pairing Code',
        AppLanguage.ja => 'ワンタイムペアリングコード',
        AppLanguage.ko => '일회용 페어링 코드',
      };

  String get pairAndConnectBtn => switch (lang) {
        AppLanguage.zh => '配对并连接',
        AppLanguage.en => 'Pair & Connect',
        AppLanguage.ja => 'ペアリングして接続',
        AppLanguage.ko => '페어링 및 연결',
      };

  String get qrUriLabel => switch (lang) {
        AppLanguage.zh => '或粘贴配对二维码 URI (nienie://pair?data=...)',
        AppLanguage.en => 'Or Paste Pairing QR URI (nienie://pair?data=...)',
        AppLanguage.ja => 'または QR URI を貼り付け (nienie://pair?data=...)',
        AppLanguage.ko => '또는 페어링 QR URI 붙여넣기 (nienie://pair?data=...)',
      };

  String get pairWithQrBtn => switch (lang) {
        AppLanguage.zh => '使用二维码 URI 配对',
        AppLanguage.en => 'Pair with QR URI',
        AppLanguage.ja => 'QR URI でペアリング',
        AppLanguage.ko => 'QR URI로 페어링',
      };

  String get savedComputersTitle => switch (lang) {
        AppLanguage.zh => '已保存的电脑',
        AppLanguage.en => 'Saved Computers',
        AppLanguage.ja => '保存済みの PC',
        AppLanguage.ko => '저장된 컴퓨터',
      };

  String get advancedOptionsLabel => switch (lang) {
        AppLanguage.zh => '高级连接选项',
        AppLanguage.en => 'Advanced Connection Options',
        AppLanguage.ja => '詳細接続オプション',
        AppLanguage.ko => '고급 연결 옵션',
      };

  String get reconnectBtn => switch (lang) {
        AppLanguage.zh => '重连',
        AppLanguage.en => 'Reconnect',
        AppLanguage.ja => '再接続',
        AppLanguage.ko => '재연결',
      };

  String get selectSessionHint => switch (lang) {
        AppLanguage.zh => '请选择一个会话以查看实时事件',
        AppLanguage.en => 'Select a session to inspect events',
        AppLanguage.ja => 'セッションを選択してイベントを表示',
        AppLanguage.ko => '이벤트를 확인할 세션을 선택하세요',
      };

  String get promptHint => switch (lang) {
        AppLanguage.zh => '向本地 Agent 发送指令...',
        AppLanguage.en => 'Send prompt to local agent...',
        AppLanguage.ja => 'ローカル Agent にプロンプトを送信...',
        AppLanguage.ko => '로컬 Agent에 프롬프트 전송...',
      };

  String get allowOnceBtn => switch (lang) {
        AppLanguage.zh => '允许一次',
        AppLanguage.en => 'Allow Once',
        AppLanguage.ja => '今回のみ許可',
        AppLanguage.ko => '한 번 허용',
      };

  String get allowAlwaysBtn => switch (lang) {
        AppLanguage.zh => '始终允许',
        AppLanguage.en => 'Allow Always',
        AppLanguage.ja => '常に許可',
        AppLanguage.ko => '항상 허용',
      };

  String get rejectBtn => switch (lang) {
        AppLanguage.zh => '拒绝',
        AppLanguage.en => 'Reject',
        AppLanguage.ja => '拒否',
        AppLanguage.ko => '거부',
      };

  String get permResultOnce => switch (lang) {
        AppLanguage.zh => '已允许一次',
        AppLanguage.en => 'Allowed once',
        AppLanguage.ja => '今回のみ許可済み',
        AppLanguage.ko => '한 번 허용됨',
      };

  String get permResultAlways => switch (lang) {
        AppLanguage.zh => '已始终允许',
        AppLanguage.en => 'Always allowed',
        AppLanguage.ja => '常に許可済み',
        AppLanguage.ko => '항상 허용됨',
      };

  String get permResultReject => switch (lang) {
        AppLanguage.zh => '已拒绝',
        AppLanguage.en => 'Rejected',
        AppLanguage.ja => '拒否済み',
        AppLanguage.ko => '거부됨',
      };

  String get permResultUnknown => switch (lang) {
        AppLanguage.zh => '结果未知，等待电脑端状态同步',
        AppLanguage.en => 'Result unknown, waiting for computer sync',
        AppLanguage.ja => '結果不明、PC側の同期を待っています',
        AppLanguage.ko => '결과 알 수 없음, PC 동기화 대기 중',
      };

  String get permUncertainNote => switch (lang) {
        AppLanguage.zh => '审批结果暂时无法确认，请勿重复操作',
        AppLanguage.en => 'Approval result cannot be confirmed yet, do not retry',
        AppLanguage.ja => '承認結果を確認できません。再操作しないでください',
        AppLanguage.ko => '승인 결과를 확인할 수 없습니다. 다시 시도하지 마세요',
      };

  String get statusReconnecting => switch (lang) {
        AppLanguage.zh => '网络重连中',
        AppLanguage.en => 'Reconnecting',
        AppLanguage.ja => '再接続中',
        AppLanguage.ko => '다시 연결 중',
      };

  String get agentThinking => switch (lang) {
        AppLanguage.zh => '思考中',
        AppLanguage.en => 'Thinking',
        AppLanguage.ja => '考え中',
        AppLanguage.ko => '생각 중',
      };

  String get agentToolRunning => switch (lang) {
        AppLanguage.zh => '运行工具',
        AppLanguage.en => 'Running tool',
        AppLanguage.ja => 'ツール実行中',
        AppLanguage.ko => '도구 실행 중',
      };

  String get agentIdle => switch (lang) {
        AppLanguage.zh => '空闲',
        AppLanguage.en => 'Idle',
        AppLanguage.ja => '待機中',
        AppLanguage.ko => '대기 중',
      };

  String get agentWaitingApproval => switch (lang) {
        AppLanguage.zh => '等待审批',
        AppLanguage.en => 'Waiting approval',
        AppLanguage.ja => '承認待ち',
        AppLanguage.ko => '승인 대기',
      };

  String get reconnectBannerPrefix => switch (lang) {
        AppLanguage.zh => '连接断开，正在重连（第 ',
        AppLanguage.en => 'Connection lost, reconnecting (attempt ',
        AppLanguage.ja => '接続が切れました。再接続中（',
        AppLanguage.ko => '연결이 끊어졌습니다. 다시 연결 중(시도 ',
      };

  String get reconnectBannerSuffix => switch (lang) {
        AppLanguage.zh => ' 次）…断线期间的会话消息将在重连后自动同步',
        AppLanguage.en => '）… conversation messages will sync after reconnect',
        AppLanguage.ja => '回目）…切断中の会話メッセージは再接続後に同期されます',
        AppLanguage.ko => '회) …끊긴 동안의 대화 메시지는 재연결 후 동기화됩니다',
      };

  String get disconnectedBanner => switch (lang) {
        AppLanguage.zh => '连接已断开',
        AppLanguage.en => 'Disconnected',
        AppLanguage.ja => '切断されました',
        AppLanguage.ko => '연결 종료됨',
      };

  String get retryConnectBtn => switch ((lang)) {
        AppLanguage.zh => '重试',
        AppLanguage.en => 'Retry',
        AppLanguage.ja => '再試行',
        AppLanguage.ko => '다시 시도',
      };

  String get deliveredReceipt => switch (lang) {
        AppLanguage.zh => '已送达电脑',
        AppLanguage.en => 'Delivered to computer',
        AppLanguage.ja => 'PCに配信済み',
        AppLanguage.ko => 'PC로 전달됨',
      };

  String get notDeliveredLabel => switch (lang) {
        AppLanguage.zh => '未送达，点击重发',
        AppLanguage.en => 'Not delivered, tap to resend',
        AppLanguage.ja => '未配信、タップで再送',
        AppLanguage.ko => '미전송, 탭하여 재전송',
      };

  String get permRequestHeader => switch (lang) {
        AppLanguage.zh => 'Agent 请求执行',
        AppLanguage.en => 'Agent requests permission',
        AppLanguage.ja => 'エージェントが実行をリクエスト',
        AppLanguage.ko => '에이전트 실행 요청',
      };

  String get permActionLabel => switch (lang) {
        AppLanguage.zh => '操作',
        AppLanguage.en => 'Action',
        AppLanguage.ja => '操作',
        AppLanguage.ko => '동작',
      };

  String get permDetailLabel => switch (lang) {
        AppLanguage.zh => '请求详情',
        AppLanguage.en => 'Request detail',
        AppLanguage.ja => 'リクエスト詳細',
        AppLanguage.ko => '요청 상세',
      };

  String get permResourcesLabel => switch (lang) {
        AppLanguage.zh => '资源对象',
        AppLanguage.en => 'Resources',
        AppLanguage.ja => '対象リソース',
        AppLanguage.ko => '대상 리소스',
      };

  String get riskLow => switch (lang) {
        AppLanguage.zh => '低风险',
        AppLanguage.en => 'Low risk',
        AppLanguage.ja => '低リスク',
        AppLanguage.ko => '낮은 위험',
      };

  String get riskMedium => switch (lang) {
        AppLanguage.zh => '中风险',
        AppLanguage.en => 'Medium risk',
        AppLanguage.ja => '中リスク',
        AppLanguage.ko => '중간 위험',
      };

  String get riskHigh => switch (lang) {
        AppLanguage.zh => '高风险',
        AppLanguage.en => 'High risk',
        AppLanguage.ja => '高リスク',
        AppLanguage.ko => '높은 위험',
      };

  String get riskUnknown => switch (lang) {
        AppLanguage.zh => '未分类',
        AppLanguage.en => 'Unclassified',
        AppLanguage.ja => '未分類',
        AppLanguage.ko => '미분류',
      };

  String get permConfirmTitle => switch (lang) {
        AppLanguage.zh => '确认始终允许',
        AppLanguage.en => 'Confirm always allow',
        AppLanguage.ja => '常に許可の確認',
        AppLanguage.ko => '항상 허용 확인',
      };

  String get permConfirmAlwaysLine => switch (lang) {
        AppLanguage.zh => '将永久允许以下操作',
        AppLanguage.en => 'This will permanently allow',
        AppLanguage.ja => '以下の操作を永久に許可します',
        AppLanguage.ko => '다음 작업을 영구히 허용합니다',
      };

  String get permConfirmOnceLine => switch (lang) {
        AppLanguage.zh => '仅本次允许以下操作',
        AppLanguage.en => 'Allow the following only once',
        AppLanguage.ja => '以下の操作を今回のみ許可します',
        AppLanguage.ko => '다음 작업을 한 번만 허용합니다',
      };

  String get permConfirmResources => switch (lang) {
        AppLanguage.zh => '生效资源',
        AppLanguage.en => 'Applies to',
        AppLanguage.ja => '対象リソース',
        AppLanguage.ko => '적용 대상',
      };

  String get permConfirmFutureNote => switch (lang) {
        AppLanguage.zh => '这会影响后续同类请求，不再每次询问',
        AppLanguage.en => 'This affects future similar requests and will not ask again',
        AppLanguage.ja => '今後の同種リクエストに影響し、毎回確認しません',
        AppLanguage.ko => '이후 유사 요청에 영향을 주며 다시 묻지 않습니다',
      };

  String get permConfirmHighRiskNote => switch (lang) {
        AppLanguage.zh => '该操作被标记为高风险，请确认后继续',
        AppLanguage.en => 'This action is marked high risk, please confirm to continue',
        AppLanguage.ja => 'この操作は高リスクと判定されています。確認して続行してください',
        AppLanguage.ko => '이 작업은 고위험으로 분류되었습니다. 확인 후 계속하세요',
      };

  String get permConfirmUnknownNote => switch (lang) {
        AppLanguage.zh => '该操作尚未分类，无法确认其风险，请谨慎决定',
        AppLanguage.en => 'This action is unclassified and its risk cannot be confirmed, please decide carefully',
        AppLanguage.ja => 'この操作は未分類でリスクを確認できません。慎重に判断してください',
        AppLanguage.ko => '이 작업은 미분류이며 위험을 확인할 수 없습니다. 신중히 결정하세요',
      };

  String get permConfirmOk => switch (lang) {
        AppLanguage.zh => '确认执行',
        AppLanguage.en => 'Confirm',
        AppLanguage.ja => '実行を確認',
        AppLanguage.ko => '실행 확인',
      };

  String get permCancelBtn => switch (lang) {
        AppLanguage.zh => '取消',
        AppLanguage.en => 'Cancel',
        AppLanguage.ja => 'キャンセル',
        AppLanguage.ko => '취소',
      };

  String get permWaitingLong => switch (lang) {
        AppLanguage.zh => '已等待较长时间，请在电脑端确认当前状态',
        AppLanguage.en => 'Waiting for a long time, please check the status on your computer',
        AppLanguage.ja => '長時間待機しています。PC側で状態を確認してください',
        AppLanguage.ko => '오래 기다리는 중입니다. PC에서 상태를 확인하세요',
      };

  String get langShortLabel => switch (lang) {
        AppLanguage.zh => '中文',
        AppLanguage.en => 'EN',
        AppLanguage.ja => '日本語',
        AppLanguage.ko => '한국어',
      };

  // ===== 4.3 相对时间戳 =====

  String get relJustNow => switch (lang) {
        AppLanguage.zh => '刚刚',
        AppLanguage.en => 'just now',
        AppLanguage.ja => 'たった今',
        AppLanguage.ko => '방금',
      };

  String relMinutesAgo(int n) => switch (lang) {
        AppLanguage.zh => '$n 分钟前',
        AppLanguage.en => n == 1 ? '1 min ago' : '$n min ago',
        AppLanguage.ja => '$n分前',
        AppLanguage.ko => '$n분 전',
      };

  String relHoursAgo(int n) => switch (lang) {
        AppLanguage.zh => '$n 小时前',
        AppLanguage.en => n == 1 ? '1 h ago' : '$n h ago',
        AppLanguage.ja => '$n時間前',
        AppLanguage.ko => '$n시간 전',
      };

  String relDaysAgo(int n) => switch (lang) {
        AppLanguage.zh => '$n 天前',
        AppLanguage.en => n == 1 ? '1 d ago' : '$n d ago',
        AppLanguage.ja => '$n日前',
        AppLanguage.ko => '$n일 전',
      };

  /// 4.3：相对时间戳（刚刚 / 3 分钟前 / 2 小时前 / 3 天前 / 11月5日）
  String relativeTime(DateTime time, {DateTime? now}) {
    final ref = now ?? DateTime.now();
    final diff = ref.difference(time);
    // 未来时间戳（时钟偏差/事件乱序）与 45~59 秒区间都归「刚刚」，不出现 0 min ago
    if (diff.isNegative || diff.inSeconds < 60) return relJustNow;
    if (diff.inMinutes < 60) return relMinutesAgo(diff.inMinutes);
    if (diff.inHours < 24) return relHoursAgo(diff.inHours);
    if (diff.inDays < 7) return relDaysAgo(diff.inDays);
    // 事件时间为 UTC ISO——日期展示必须转本地时区（否则 UTC 午夜前后显示错天）
    final localTime = time.toLocal();
    const monthsEn = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return switch (lang) {
      AppLanguage.zh => '${localTime.month}月${localTime.day}日',
      AppLanguage.en => '${monthsEn[localTime.month - 1]} ${localTime.day}',
      AppLanguage.ja => '${localTime.month}/${localTime.day}',
      AppLanguage.ko => '${localTime.month}.${localTime.day}',
    };
  }

  // ===== 4.2 代码块复制 =====

  String get copyCodeLabel => switch (lang) {
        AppLanguage.zh => '复制代码',
        AppLanguage.en => 'Copy code',
        AppLanguage.ja => 'コードをコピー',
        AppLanguage.ko => '코드 복사',
      };

  String get codeCopiedLabel => switch (lang) {
        AppLanguage.zh => '已复制',
        AppLanguage.en => 'Copied',
        AppLanguage.ja => 'コピーしました',
        AppLanguage.ko => '복사됨',
      };
}
