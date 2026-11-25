import { useState } from 'react';
import { api, setCsrfToken, type SessionInfo } from '../api';
import { ErrorNote } from '../ui';

export function LoginPage({ session, onLoggedIn }: { session: SessionInfo; onLoggedIn: () => Promise<void> }) {
  const demo = session.demo_credentials;
  const [username, setUsername] = useState(demo?.username ?? '');
  const [password, setPassword] = useState(demo?.password ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="center-page">
      <form
        className="login card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api.login(username, password);
            setCsrfToken(r.csrf_token);
            await onLoggedIn();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand">
          <span className="brand-mark" aria-hidden>₮</span>
          <div>
            <strong>USDT Payment Reconciler</strong>
            <small>Admin dashboard</small>
          </div>
        </div>
        {demo && (
          <p className="demo-note">
            Public demo. Log in as <code>{demo.username}</code> / <code>{demo.password}</code>. Everything here is
            simulated: no real wallet, chain or money.
          </p>
        )}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required maxLength={64} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required maxLength={256} />
        </label>
        <ErrorNote message={error} />
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
