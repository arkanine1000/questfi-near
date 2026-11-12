import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installConsoleHelpers } from './services/hostKeys';
import './styles/index.css';

// window.questfi.setOperatorKey(…) — for driving a kiosk or TV where
// clicking through the landing view is awkward.
installConsoleHelpers();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
