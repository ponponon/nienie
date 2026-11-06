import React from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopApp } from './DesktopApp.js';

function bootstrapClient() {
  const container = document.getElementById('nienie-app-root');
  const initialState = window.__NIENIE_INITIAL_STATE__;
  if (!container || !initialState) {
    return;
  }

  const root = createRoot(container);
  root.render(<DesktopApp initialState={initialState} initialLocale={initialState.locale} />);

  if (typeof EventSource !== 'undefined') {
    const es = new EventSource('/api/hot-reload');
    es.onmessage = (ev) => {
      if (ev.data === 'reload') {
        window.location.reload();
      }
    };
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapClient);
} else {
  bootstrapClient();
}
