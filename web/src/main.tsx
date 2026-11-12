import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './styles/style.css';
import './styles/pages.css';
import './styles/v2.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');
createRoot(root).render(<StrictMode><ErrorBoundary scope="app"><App /></ErrorBoundary></StrictMode>);
