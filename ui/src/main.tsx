import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import './studio.css';
import { applyTheme, followNativeTheme, savedTheme } from './theme.ts';
import { view } from './native.ts';
import { Onboarding } from './views/Onboarding.tsx';
import { SettingsView } from './views/Settings.tsx';
import { migrateBrowserPreferences } from './legacy-preferences.ts';

migrateBrowserPreferences();
applyTheme(savedTheme(), false);
followNativeTheme();

/** Keeps a UI crash from blanking the page, and shows where it happened so it can be reported. */
class CrashGuard extends Component<{ children: ReactNode }, { error: Error | null; where: string }> {
  state = { error: null as Error | null, where: '' };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    const where = (info.componentStack ?? '').trim().split('\n').slice(0, 6).join('\n');
    this.setState({ where });
    console.error('[Open Smart Buttons] UI error', error, where);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h2>Something in the window broke.</h2>
        <p>Your buttons and settings are safe. Reload to continue.</p>
        <pre>{String(this.state.error?.stack ?? this.state.error).split('\n').slice(0, 4).join('\n')}{'\n'}{this.state.where}</pre>
        <button className="primary" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!, {
  onCaughtError: (error, info) => console.error('[Open Smart Buttons] caught', error, info.componentStack),
  onUncaughtError: (error, info) => console.error('[Open Smart Buttons] uncaught', error, info.componentStack),
}).render(<CrashGuard>{view === 'onboarding' ? <Onboarding /> : view === 'settings' ? <SettingsView /> : <App />}</CrashGuard>);
