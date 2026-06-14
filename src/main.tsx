import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Tooltip from '@radix-ui/react-tooltip';
import App from './App';
import { I18nProvider } from './lib/I18nProvider';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'highlight.js/styles/github.css';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <Tooltip.Provider delayDuration={300} skipDelayDuration={150}>
        <App />
      </Tooltip.Provider>
    </I18nProvider>
  </React.StrictMode>
);
