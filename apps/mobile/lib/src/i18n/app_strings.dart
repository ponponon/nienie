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

  String get langShortLabel => switch (lang) {
        AppLanguage.zh => '中文',
        AppLanguage.en => 'EN',
        AppLanguage.ja => '日本語',
        AppLanguage.ko => '한국어',
      };
}
