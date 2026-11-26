import { useEffect, useState } from 'react';
import { api, setCsrfToken, setUnauthorizedHandler, type SessionInfo } from './api';
import { AccountPage } from './pages/AccountPage';
import { HealthPage } from './pages/HealthPage';
import { LoginPage } from './pages/LoginPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { OrdersPage } from './pages/OrdersPage';
import { ReportsPage } from './pages/ReportsPage';
import { ReviewPage } from './pages/ReviewPage';

/** Minimal hash router: #/orders, #/orders/<id>, #/review, #/reports, #/health, #/account */
function useHashRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const onChange = () => setParts(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parts;
}

const NAV = [
  { href: '#/orders', key: 'orders', label: 'Orders' },
  { href: '#/review', key: 'review', label: 'Review queue' },
  { href: '#/reports', key: 'reports', label: 'Reconciliation' },
  { href: '#/health', key: 'health', label: 'Health' },
  { href: '#/account', key: 'account', label: 'Account' },
];

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const route = useHashRoute();

  const refreshSession = async () => {
    try {
      const s = await api.session();
      setCsrfToken(s.csrf_token);
      setSession(s);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };

  useEffect(() => {
    setUnauthorizedHandler(() => void refreshSession());
    void refreshSession();
  }, []);

  if (loadError) return <div className="center-page"><p className="error-note">Cannot reach the server: {loadError}</p></div>;
  if (!session) return <div className="center-page"><p className="muted">Loading…</p></div>;
  if (!session.authenticated) return <LoginPage session={session} onLoggedIn={refreshSession} />;

  const section = route[0] ?? 'orders';
  let page;
  if (section === 'orders' && route[1]) page = <OrderDetailPage id={route[1]} session={session} />;
  else if (section === 'review') page = <ReviewPage />;
  else if (section === 'reports') page = <ReportsPage session={session} />;
  else if (section === 'health') page = <HealthPage session={session} />;
  else if (section === 'account') page = <AccountPage session={session} />;
  else page = <OrdersPage session={session} />;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>₮</span>
          <div>
            <strong>USDT Reconciler</strong>
            <small>watch-only</small>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <a key={n.key} href={n.href} className={section === n.key ? 'active' : ''}>{n.label}</a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`mode mode-${session.mode}`}>{session.mode === 'demo' ? 'DEMO · simulated chains' : session.mode === 'mainnet' ? 'MAINNET · read-only' : 'TESTNET'}</span>
          <span className="muted">Signed in as {session.username}</span>
          <button
            className="btn btn-ghost"
            onClick={async () => {
              await api.logout().catch(() => undefined);
              await refreshSession();
            }}
          >
            Log out
          </button>
        </div>
      </aside>
      <main className="content">
        {session.mode === 'demo' && (
          <div className="demo-banner">
            Demo mode: all data and payments are simulated. No real wallet, blockchain or money is involved.
          </div>
        )}
        {page}
      </main>
    </div>
  );
}
