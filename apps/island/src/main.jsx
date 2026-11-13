import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The shared tokens and frame load first, so a component's own stylesheet
// (imported by the component, further down this graph) comes later in the
// cascade and can override them without raising its specificity.
import './styles/index.css';
import App from './App';
import { installConsoleHelpers } from './services/hostKeys';

// window.questfi.setOperatorKey(…) — for driving a kiosk or TV where
// clicking through the landing view is awkward.
installConsoleHelpers();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
