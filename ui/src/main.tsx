import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.tsx';
import { installHost } from './addonHost.ts';

installHost(); // add-on screens use the POS's React and session (window.__POS__)

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
