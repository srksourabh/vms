import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { registerServiceWorker } from './lib/registerSw';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('No #root element found');

registerServiceWorker();

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
