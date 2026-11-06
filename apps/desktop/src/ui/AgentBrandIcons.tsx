import React from 'react';

export function renderAgentBrandLogo(agentId: string): React.ReactNode {
  switch (agentId) {
    case 'opencode':
      // Official OpenCode brand mark (from SST/OpenCode packages/console/app/src/asset/brand/opencode-logo-light-square.svg)
      return (
        <svg width="20" height="20" viewBox="0 0 300 300" fill="none" xmlns="http://www.w3.org/2000/svg">
          <g transform="translate(30, 0)">
            <path d="M180 240H60V120H180V240Z" fill="#CFCECD" />
            <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#211E1E" />
          </g>
        </svg>
      );

    case 'codex':
      // Official OpenAI Codex brand icon (@lobehub/icons-static-svg/icons/codex-color.svg)
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
            fill="url(#nienie-codex-grad)"
          />
          <defs>
            <linearGradient gradientUnits="userSpaceOnUse" id="nienie-codex-grad" x1="12" x2="12" y1="3" y2="21">
              <stop stopColor="#B1A7FF" />
              <stop offset="0.5" stopColor="#7A9DFF" />
              <stop offset="1" stopColor="#3941FF" />
            </linearGradient>
          </defs>
        </svg>
      );

    case 'claude-code':
      // Official Claude Code brand icon (@lobehub/icons-static-svg/icons/claudecode-color.svg)
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            clipRule="evenodd"
            fillRule="evenodd"
            d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
            fill="#D97757"
          />
        </svg>
      );

    case 'pi':
      // Official Pi coding agent brand icon (@lobehub/icons-static-svg/icons/pi.svg)
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="#18181B" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg">
          <path clipRule="evenodd" d="M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z" />
          <path d="M17.5 12H23v11h-5.5V12z" fill="#10B981" />
        </svg>
      );

    case 'acp':
      // Official Agent Client Protocol / MCP interlocking protocol icon (@lobehub/icons-static-svg/icons/mcp.svg)
      return (
        <svg width="19" height="19" viewBox="0 0 24 24" fill="#2563EB" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg">
          <path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" />
          <path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" />
        </svg>
      );

    case 'openclaw':
      // Official OpenClaw brand icon (@lobehub/icons-static-svg/icons/openclaw-color.svg)
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M12 2.568c-6.33 0-9.495 5.275-9.495 9.495 0 4.22 3.165 8.44 6.33 9.494v2.11h2.11v-2.11s1.055.422 2.11 0v2.11h2.11v-2.11c3.165-1.055 6.33-5.274 6.33-9.494S18.33 2.568 12 2.568z"
            fill="url(#nienie-openclaw-0)"
          />
          <path
            d="M3.56 9.953C.396 8.898-.66 11.008.396 13.118c1.055 2.11 3.164 1.055 4.22-1.055.632-1.477 0-2.11-1.056-2.11z"
            fill="url(#nienie-openclaw-1)"
          />
          <path
            d="M20.44 9.953c3.164-1.055 4.22 1.055 3.164 3.165-1.055 2.11-3.164 1.055-4.22-1.055-.632-1.477 0-2.11 1.056-2.11z"
            fill="url(#nienie-openclaw-2)"
          />
          <path
            d="M5.507 1.875c.476-.285 1.036-.233 1.615.037.577.27 1.223.774 1.937 1.488a.316.316 0 01-.447.447c-.693-.693-1.279-1.138-1.757-1.361-.475-.222-.795-.205-1.022-.069a.317.317 0 01-.326-.542zM16.877 1.913c.58-.27 1.14-.323 1.616-.038a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.069-.478.223-1.064.668-1.756 1.361a.316.316 0 11-.448-.447c.714-.714 1.36-1.218 1.936-1.487z"
            fill="#FF4D4D"
          />
          <path
            d="M8.835 9.109a1.266 1.266 0 100-2.532 1.266 1.266 0 000 2.532zM15.165 9.109a1.266 1.266 0 100-2.532 1.266 1.266 0 000 2.532z"
            fill="#050810"
          />
          <path
            d="M9.046 8.16a.527.527 0 100-1.056.527.527 0 000 1.055zM15.376 8.16a.527.527 0 100-1.055.527.527 0 000 1.054z"
            fill="#00E5CC"
          />
          <defs>
            <linearGradient gradientUnits="userSpaceOnUse" id="nienie-openclaw-0" x1="-0.659" x2="27.023" y1="0.458" y2="22.855">
              <stop stopColor="#FF4D4D" />
              <stop offset="1" stopColor="#991B1B" />
            </linearGradient>
            <linearGradient gradientUnits="userSpaceOnUse" id="nienie-openclaw-1" x1="0" x2="4.311" y1="9.672" y2="14.949">
              <stop stopColor="#FF4D4D" />
              <stop offset="1" stopColor="#991B1B" />
            </linearGradient>
            <linearGradient gradientUnits="userSpaceOnUse" id="nienie-openclaw-2" x1="19.385" x2="24.399" y1="9.953" y2="14.462">
              <stop stopColor="#FF4D4D" />
              <stop offset="1" stopColor="#991B1B" />
            </linearGradient>
          </defs>
        </svg>
      );

    case 'pty':
    default:
      // macOS Terminal / PTY Console app icon
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="3" width="20" height="18" rx="4" fill="#1E242B" />
          <path
            d="M6.5 9L10 12L6.5 15"
            stroke="#17B378"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12 15H16.5"
            stroke="#E2E8F0"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
