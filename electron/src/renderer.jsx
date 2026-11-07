import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from '@/app/App.jsx';
import ErrorBoundary from '@/app/ErrorBoundary.jsx';
import '@fontsource/sora/400.css';
import '@fontsource/sora/500.css';
import '@fontsource/sora/600.css';
import '@fontsource/sora/700.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import './index.css';

const container = document.getElementById("root");
const root = createRoot(container);
root.render(
  <MotionConfig reducedMotion="user">
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </MotionConfig>,
);
