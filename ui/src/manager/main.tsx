import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { ManagerApp } from './ManagerApp.tsx';

createRoot(document.getElementById('root')!).render(<StrictMode><ManagerApp /></StrictMode>);
