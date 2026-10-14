import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app';
import { SettingsWindow } from './settings-window';
import { JournalBookWindow } from './journal-book';
import './styles.css';

// Startup-freeze diagnosis: any main-thread task ≥200ms is reported (main process
// forwards renderer console into journal.log), so a frozen phase after the window
// becomes visible leaves a dated trace instead of being anecdotal.
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      console.warn(`[longtask] ${Math.round(e.duration)}ms @ ${Math.round(e.startTime)}ms`);
    }
  }).observe({ entryTypes: ['longtask'] });
} catch {
  // longtask unsupported — diagnosis only, never a functional dependency
}
console.info(`[boot] renderer scripts start @ ${Math.round(performance.now())}ms`);

// The main, settings and journal-book windows load the same renderer bundle; the
// BrowserWindow appends ?window=<kind>, and the entry branches on it.
const windowKind = new URLSearchParams(window.location.search).get('window');
// Expose the window kind to CSS — the journal-book window needs a transparent
// document root (transparent BrowserWindow); the others keep the panel fill.
if (windowKind) document.documentElement.dataset.window = windowKind;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {windowKind === 'settings' ? (
      <SettingsWindow />
    ) : windowKind === 'journal' ? (
      <JournalBookWindow />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
