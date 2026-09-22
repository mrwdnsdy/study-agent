import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { detectMode } from './lib/mode';
import './styles.css';

detectMode().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
