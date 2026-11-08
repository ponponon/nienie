export const DESKTOP_MODERN_CSS = `
  :root {
    --color-bg-primary: #F2F2F7;
    --color-canvas: #F1F2F5;
    --color-surface: #FFFFFF;
    --color-surface-subtle: #F8F9FA;
    --color-green: #17B378;
    --color-green-hover: #149F6A;
    --color-green-soft: rgba(23, 179, 120, 0.1);
    --color-text-primary: #141416;
    --color-text-secondary: #6E7178;
    --color-text-muted: #989BA2;
    --color-divider: rgba(0, 0, 0, 0.055);
    --color-border: rgba(0, 0, 0, 0.075);
    --color-btn-border: #DCDFE4;
    --font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif;
    --font-mono: 'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.025), 0 4px 12px rgba(0, 0, 0, 0.015);
    --shadow-sidebar: 0 2px 10px rgba(0, 0, 0, 0.025), 0 1px 2px rgba(0, 0, 0, 0.03);
    --shadow-btn: 0 1px 2px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.85);
    --shadow-popover: 0 12px 32px -4px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.05), 0 0 0 1px rgba(0, 0, 0, 0.07);
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html, body {
    width: 100%;
    height: 100vh;
    max-width: 100vw;
    overflow: hidden;
    overflow-x: hidden;
    background: var(--color-canvas);
    color: var(--color-text-primary);
    font-family: var(--font-family);
    font-size: 13.5px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    user-select: none;
  }

  #nienie-app-root {
    width: 100%;
    height: 100vh;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  /* Native traffic light spacing rule */
  .title-bar-compat {
    padding-left: 78px;
    grid-template-columns: minmax(0, 1fr);
  }

  .wetype-shell {
    display: flex;
    width: 100%;
    height: 100vh;
    padding: 12px;
    gap: 20px;
  }

  /* Left Floating White Sidebar (WeType + Raycast refinement) */
  .wetype-sidebar {
    width: 210px;
    flex-shrink: 0;
    background: var(--color-surface);
    border-radius: 14px;
    border: 1px solid rgba(0, 0, 0, 0.045);
    padding: 48px 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    box-shadow: var(--shadow-sidebar);
    -webkit-app-region: drag;
  }

  .nav-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
    -webkit-app-region: no-drag;
  }

  .nav-item {
    -webkit-app-region: no-drag;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-radius: 9px;
    border: none;
    background: transparent;
    color: #2C2E33;
    font-family: var(--font-family);
    font-size: 14.5px;
    font-weight: 500;
    letter-spacing: -0.01em;
    cursor: pointer;
    text-align: left;
    outline: none;
    transition: background-color 0.14s ease, color 0.14s ease, transform 0.1s ease, box-shadow 0.14s ease;
  }

  .nav-item:hover:not([data-state="active"]):not(.active) {
    background: rgba(0, 0, 0, 0.038);
    color: var(--color-text-primary);
  }

  .nav-item:active {
    transform: scale(0.985);
  }

  .nav-item[data-state="active"],
  .nav-item.active {
    background: linear-gradient(180deg, #19BD7E 0%, #15A86F 100%);
    color: #FFFFFF;
    font-weight: 600;
    box-shadow: 0 2px 6px rgba(23, 179, 120, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.22);
  }

  .nav-item svg {
    flex-shrink: 0;
    opacity: 0.85;
    transition: opacity 0.14s ease;
  }

  .nav-item[data-state="active"] svg,
  .nav-item.active svg {
    opacity: 1;
  }

  .sidebar-footer {
    margin-top: auto;
    padding: 10px 10px 2px;
    border-top: 1px solid var(--color-divider);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11.5px;
    color: var(--color-text-secondary);
    -webkit-app-region: no-drag;
  }

  .status-pill-mini {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
    color: var(--color-text-primary);
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #C4C7CE;
    transition: background-color 0.2s ease, box-shadow 0.2s ease;
  }

  .status-dot.running {
    background: var(--color-green);
    box-shadow: 0 0 0 3px rgba(23, 179, 120, 0.16);
  }

  .status-dot.error {
    background: #EF4444;
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.16);
  }

  /* Right Content Canvas */
  .wetype-main {
    flex: 1;
    min-width: 0;
    height: 100%;
    overflow-y: auto;
    padding: 10px 14px 24px 2px;
  }

  .wetype-main::-webkit-scrollbar {
    width: 6px;
  }

  .wetype-main::-webkit-scrollbar-thumb {
    background: rgba(0, 0, 0, 0.12);
    border-radius: 999px;
  }

  .pane-header {
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    -webkit-app-region: drag;
  }

  .pane-header button,
  .pane-header div {
    -webkit-app-region: no-drag;
  }

  .pane-title {
    font-size: 16.5px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--color-text-primary);
  }

  .tab-pane[data-state="inactive"] {
    display: none;
  }

  .tab-pane[data-state="active"] {
    display: block;
    animation: tabFadeIn 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes tabFadeIn {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Pure White Grouped Card (shadcn/ui + WeType hybrid) */
  .wetype-group {
    background: var(--color-surface);
    border-radius: 12px;
    padding: 0 20px;
    margin-bottom: 14px;
    border: 1px solid rgba(0, 0, 0, 0.055);
    box-shadow: var(--shadow-card);
  }

  .wetype-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 15px 0;
    border-bottom: 1px solid var(--color-divider);
    min-width: 0;
  }

  .wetype-row:last-child {
    border-bottom: none;
  }

  .wetype-row.interactive {
    cursor: pointer;
    transition: opacity 0.12s ease;
  }

  .wetype-row.interactive:hover .row-title {
    color: #000000;
  }

  .row-left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .qr-row-left {
    display: flex;
    align-items: center;
    gap: 22px;
    min-width: 0;
  }

  /* Hardware-style QR showcase frame */
  .qr-box {
    flex-shrink: 0;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    padding: 8px;
    background: #FFFFFF;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04), inset 0 0 0 1px rgba(255, 255, 255, 0.6);
    transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .qr-box:hover {
    transform: scale(1.015);
  }

  .qr-box svg {
    width: 114px;
    height: 114px;
    display: block;
  }

  .row-title {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--color-text-primary);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .row-sub-inline {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-secondary);
    background: var(--color-surface-subtle);
    border: 1px solid rgba(0, 0, 0, 0.05);
    padding: 1px 6px;
    border-radius: 5px;
  }

  .row-desc {
    font-size: 12px;
    font-weight: 400;
    color: var(--color-text-secondary);
    margin-top: 3px;
    line-height: 1.45;
  }

  .row-desc code,
  .inline-code-pill {
    font-family: var(--font-mono);
    font-size: 11px;
    color: #4A4D55;
    background: #F4F5F7;
    padding: 1.5px 6px;
    border-radius: 4px;
    border: 1px solid rgba(0, 0, 0, 0.045);
    user-select: all;
  }

  /* 6-Digit Pairing Code Display */
  .code-display-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .code-display {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: 2.5px;
    color: var(--color-green);
    background: linear-gradient(180deg, rgba(23, 179, 120, 0.09) 0%, rgba(23, 179, 120, 0.05) 100%);
    border: 1px solid rgba(23, 179, 120, 0.22);
    padding: 5px 14px;
    border-radius: 9px;
    user-select: all;
    cursor: pointer;
    transition: background-color 0.14s ease, border-color 0.14s ease, transform 0.1s ease;
  }

  .code-display:hover {
    border-color: rgba(23, 179, 120, 0.4);
    background: rgba(23, 179, 120, 0.12);
  }

  .code-display:active {
    transform: scale(0.98);
  }

  /* Agent Brand Box & Status Pill */
  .agent-brand-box {
    width: 34px;
    height: 34px;
    border-radius: 9px;
    background: #FFFFFF;
    border: 1px solid rgba(0, 0, 0, 0.08);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03), inset 0 1px 0 rgba(255, 255, 255, 0.8);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .agent-brand-box.offline {
    background: #FAFAFB;
  }

  .agent-icon-box {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: #F5F6F8;
    border: 1px solid rgba(0, 0, 0, 0.05);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #52555D;
    flex-shrink: 0;
  }

  .agent-icon-box.available {
    background: rgba(23, 179, 120, 0.09);
    border-color: rgba(23, 179, 120, 0.2);
    color: var(--color-green);
  }

  .badge-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 500;
    padding: 3px 9px;
    border-radius: 999px;
    background: #F4F5F7;
    color: var(--color-text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .badge-pill.ready {
    background: rgba(23, 179, 120, 0.1);
    color: #129663;
  }

  /* WeType Radio Indicator */
  .wetype-radio {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1.5px solid #C8CBD2;
    background: #FFFFFF;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
  }

  .wetype-radio.checked {
    border-color: var(--color-green);
    background: var(--color-green);
    box-shadow: 0 0 0 3px rgba(23, 179, 120, 0.14);
  }

  .wetype-radio.checked::after {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #FFFFFF;
  }

  /* Radix UI Switch (@radix-ui/react-switch) */
  .wetype-switch {
    position: relative;
    width: 42px;
    height: 24px;
    border-radius: 999px;
    background-color: #DCDFE5;
    border: 1px solid rgba(0, 0, 0, 0.06);
    cursor: pointer;
    outline: none;
    transition: background-color 0.2s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.15s ease;
    flex-shrink: 0;
    padding: 0;
  }

  .wetype-switch:focus-visible {
    box-shadow: 0 0 0 3px rgba(23, 179, 120, 0.25);
  }

  .wetype-switch[data-state="checked"],
  .wetype-switch.on {
    background-color: var(--color-green);
    border-color: rgba(0, 0, 0, 0.04);
  }

  .wetype-switch-thumb {
    display: block;
    width: 20px;
    height: 20px;
    background-color: #FFFFFF;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22), 0 1px 1px rgba(0, 0, 0, 0.1);
    transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
    transform: translateX(1px);
    will-change: transform;
  }

  .wetype-switch[data-state="checked"] .wetype-switch-thumb,
  .wetype-switch.on .wetype-switch-thumb {
    transform: translateX(19px);
  }

  /* Modern Tactile Buttons (shadcn/ui inspired) */
  .wetype-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: linear-gradient(180deg, #FFFFFF 0%, #FBFBFC 100%);
    border: 1px solid var(--color-btn-border);
    border-radius: 7px;
    padding: 5.5px 12px;
    font-family: var(--font-family);
    font-size: 12.5px;
    font-weight: 500;
    color: var(--color-text-primary);
    box-shadow: var(--shadow-btn);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    outline: none;
    transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease, box-shadow 0.12s ease;
  }

  .wetype-btn:hover:not(:disabled) {
    background: #F6F7F9;
    border-color: #C6CAD2;
  }

  .wetype-btn:active:not(:disabled) {
    transform: scale(0.975);
    background: #F0F1F4;
  }

  .wetype-btn:focus-visible {
    box-shadow: 0 0 0 3px rgba(23, 179, 120, 0.22);
    border-color: var(--color-green);
  }

  .wetype-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .wetype-btn.primary {
    background: linear-gradient(180deg, #19BD7E 0%, #15A86F 100%);
    border-color: #139A65;
    color: #FFFFFF;
    box-shadow: 0 1px 2px rgba(23, 179, 120, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.2);
  }

  .wetype-btn.primary:hover:not(:disabled) {
    background: linear-gradient(180deg, #17AE74 0%, #139A65 100%);
    border-color: #118859;
  }

  .wetype-btn.danger-ghost {
    color: #DC2626;
    border-color: rgba(220, 38, 38, 0.25);
    background: rgba(254, 242, 242, 0.6);
  }

  .wetype-btn.danger-ghost:hover:not(:disabled) {
    background: #FEE2E2;
    border-color: rgba(220, 38, 38, 0.4);
  }

  /* Modern Input with Focus Ring */
  .wetype-input {
    background: #F7F8FA;
    border: 1px solid #DFE2E8;
    border-radius: 7px;
    padding: 6.5px 11px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--color-text-primary);
    width: 240px;
    outline: none;
    transition: border-color 0.14s ease, background-color 0.14s ease, box-shadow 0.14s ease;
  }

  .wetype-input:hover {
    border-color: #CBD0D8;
  }

  .wetype-input:focus {
    background: #FFFFFF;
    border-color: var(--color-green);
    box-shadow: 0 0 0 3px rgba(23, 179, 120, 0.15);
  }

  /* Radix UI Select (@radix-ui/react-select) */
  .radix-select-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 136px;
    background: linear-gradient(180deg, #FFFFFF 0%, #FBFBFC 100%);
    border: 1px solid var(--color-btn-border);
    border-radius: 7px;
    padding: 5.5px 10px 5.5px 12px;
    font-family: var(--font-family);
    font-size: 12.5px;
    font-weight: 500;
    color: var(--color-text-primary);
    box-shadow: var(--shadow-btn);
    cursor: pointer;
    outline: none;
    transition: background 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
  }

  .radix-select-trigger:hover {
    background: #F6F7F9;
    border-color: #C6CAD2;
  }

  .radix-select-trigger:focus-visible,
  .radix-select-trigger[data-state="open"] {
    border-color: var(--color-green);
    box-shadow: 0 0 0 3px rgba(23, 179, 120, 0.18);
  }

  .radix-select-content {
    overflow: hidden;
    background: rgba(255, 255, 255, 0.96);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-radius: 10px;
    box-shadow: var(--shadow-popover);
    padding: 5px;
    min-width: 148px;
    z-index: 1000;
    animation: selectContentShow 0.14s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes selectContentShow {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(-2px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .radix-select-item {
    font-family: var(--font-family);
    font-size: 12.5px;
    font-weight: 500;
    color: var(--color-text-primary);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6.5px 10px;
    cursor: pointer;
    user-select: none;
    outline: none;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .radix-select-item[data-highlighted] {
    background: rgba(23, 179, 120, 0.1);
    color: #0F8A5B;
  }

  .radix-select-item[data-state="checked"] {
    font-weight: 600;
    color: var(--color-green);
  }

  /* Radix Collapsible */
  .collapsible-trigger-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 13px 0;
    background: none;
    border: none;
    font-family: var(--font-family);
    font-size: 12.5px;
    font-weight: 500;
    color: var(--color-text-secondary);
    cursor: pointer;
    outline: none;
    transition: color 0.12s ease;
  }

  .collapsible-trigger-row:hover {
    color: var(--color-text-primary);
  }

  .chevron-rotate {
    transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
    color: #A0A4AD;
  }

  [data-state="open"] > .chevron-rotate,
  .chevron-rotate.open {
    transform: rotate(90deg);
    color: var(--color-text-primary);
  }

  .expand-drawer {
    padding: 2px 0 16px;
    border-bottom: 1px solid var(--color-divider);
    animation: tabFadeIn 0.15s ease;
  }

  /* Diagnostic Log Terminal Stream */
  .log-stream {
    padding: 8px 0 14px;
    max-height: 195px;
    overflow-y: auto;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--color-text-secondary);
  }

  .log-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 5px;
    transition: background-color 0.1s ease;
  }

  .log-row:hover {
    background: #F6F7F9;
  }

  .log-time {
    color: #9CA0A9;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .log-level {
    font-size: 10px;
    font-weight: 600;
    padding: 0.5px 5px;
    border-radius: 4px;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .log-level.info {
    background: rgba(23, 179, 120, 0.1);
    color: #139A65;
  }

  .log-level.warn {
    background: rgba(245, 158, 11, 0.12);
    color: #D97706;
  }

  .log-level.error {
    background: rgba(239, 68, 68, 0.12);
    color: #DC2626;
  }

  .log-msg {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #363940;
  }

  /* WeType Upgrade & Feedback Page */
  .about-pane-inner {
    min-height: calc(100vh - 64px);
    display: flex;
    flex-direction: column;
  }

  .about-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 22px 0 22px;
  }

  .about-app-icon {
    width: 76px;
    height: 76px;
    border-radius: 19px;
    overflow: hidden;
    background: #FCE7DD;
    box-shadow: 0 8px 20px -4px rgba(67, 82, 129, 0.22);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .about-app-icon img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .about-app-name {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--color-text-primary);
    margin-top: 12px;
  }

  .about-app-version {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--color-text-secondary);
    background: rgba(0, 0, 0, 0.04);
    padding: 2px 9px;
    border-radius: 999px;
    margin-top: 5px;
  }

  .about-footer {
    margin-top: auto;
    padding-top: 20px;
    text-align: center;
    font-size: 11.5px;
    color: #8E929B;
    line-height: 1.75;
  }

  .about-links {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    margin-top: 2px;
  }

  .about-link {
    color: #6E7178;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    background: none;
    border: none;
    font-size: 11.5px;
    font-family: var(--font-family);
    transition: color 0.12s ease;
  }

  .about-link:hover {
    color: var(--color-text-primary);
  }

  /* Radix Dialog Modal */
  .radix-dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.28);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 999;
    animation: tabFadeIn 0.15s ease;
  }

  .radix-dialog-content {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 90vw;
    max-width: 420px;
    background: #FFFFFF;
    border-radius: 14px;
    padding: 20px 22px;
    box-shadow: var(--shadow-popover);
    z-index: 1000;
    outline: none;
  }

  .radix-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .radix-dialog-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .radix-dialog-body {
    font-size: 13px;
    line-height: 1.6;
    color: var(--color-text-secondary);
    margin-bottom: 18px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .spin-anim {
    animation: spin 0.75s linear infinite;
  }
`;
