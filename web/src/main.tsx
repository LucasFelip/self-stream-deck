import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyLook, readLook } from './features/appearance/appearance';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './styles/style.css';
import './styles/pages.css';
import './styles/v2.css';

// the demonstration (vite --mode demo): the PC is a recording; the normal build drops this line and never contains the recording
if (import.meta.env.MODE === 'demo') (await import('./demo/shim')).installDemo();

// the look chosen on this phone (accent and text size), on the page before it is drawn
applyLook(readLook());

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');
createRoot(root).render(<StrictMode><ErrorBoundary scope="app"><App /></ErrorBoundary></StrictMode>);
