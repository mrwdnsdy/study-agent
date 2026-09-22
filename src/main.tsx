import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { detectMode } from './lib/mode';
import { loadSiteConfig } from './browser/settings';
import './styles.css';

detectMode()
  .then((mode) => (mode === 'browser' ? loadSiteConfig() : undefined))
  .catch(() => undefined)
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
