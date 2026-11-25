import { useState, type ReactNode } from 'react';
import { api, setCsrfToken, type SessionInfo } from '../api';
import { ErrorNote } from '../ui';

type View = 'login' | 'forgot' | 'reset';

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden>₮</span>
      <div>
        <strong>USDT Payment Reconciler</strong>
        <small>Admin dashboard</small>
      </div>
    </div>
  );
}

function Shell({ onSubmit, children }: { onSubmit: () => Promise<void>; children: ReactNode }) {
  return (
    <div className="center-page">
      <form
        className="login card"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <Brand />
        {children}
      </form>
    </div>
  );
}

export function LoginPage({ session, onLoggedIn }: { session: SessionInfo; onLoggedIn: () => Promise<void> }) {
  const demo = session.demo_credentials;
  const [view, setView] = useState<View>('login');
  const [username, setUsername] = useState(demo?.username ?? '');
  const [password, setPassword] = useState(demo?.password ?? '');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (next: View) => {
    setView(next);
    setError(null);
    if (next !== 'login') setInfo(null);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (view === 'forgot') {
    return (
      <Shell
        onSubmit={() =>
          run(async () => {
            await api.forgotPassword(username);
            setCode('');
            setNewPassword('');
            setConfirmPassword('');
            go('reset');
            setInfo('If that account exists, a one-time code was sent to the admin Telegram chat. It expires in 15 minutes.');
          })
        }
      >
        <h2 className="login-title">Forgot password</h2>
        <p className="hint">Enter your username. A one-time reset code will be sent to the admin Telegram chat.</p>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required maxLength={64} />
        </label>
        <ErrorNote message={error} />
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send reset code'}</button>
        <button type="button" className="link-btn" onClick={() => go('reset')}>I already have a code</button>
        <button type="button" className="link-btn" onClick={() => go('login')}>Back to sign in</button>
      </Shell>
    );
  }

  if (view === 'reset') {
    return (
      <Shell
        onSubmit={() =>
          run(async () => {
            if (newPassword !== confirmPassword) throw new Error('The two new passwords do not match');
            await api.resetPassword(username, code, newPassword);
            setPassword('');
            go('login');
            setInfo('Password changed. Sign in with your new password.');
          })
        }
      >
        <h2 className="login-title">Set a new password</h2>
        {info && <p className="demo-note">{info}</p>}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required maxLength={64} />
        </label>
        <label>
          Code from Telegram
          <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required maxLength={64} placeholder="XXXXX-XXXXX" />
        </label>
        <label>
          New password (12+ characters)
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required minLength={12} maxLength={128} />
        </label>
        <label>
          Repeat new password
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required minLength={12} maxLength={128} />
        </label>
        <ErrorNote message={error} />
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
        <button type="button" className="link-btn" onClick={() => go('forgot')}>Send a new code</button>
        <button type="button" className="link-btn" onClick={() => go('login')}>Back to sign in</button>
      </Shell>
    );
  }

  return (
    <Shell
      onSubmit={() =>
        run(async () => {
          const r = await api.login(username, password);
          setCsrfToken(r.csrf_token);
          await onLoggedIn();
        })
      }
    >
      {demo && (
        <p className="demo-note">
          Public demo. Log in as <code>{demo.username}</code> / <code>{demo.password}</code>. Everything here is
          simulated: no real wallet, chain or money.
        </p>
      )}
      {info && <p className="ok-note">{info}</p>}
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
      {session.password_reset_available ? (
        <button type="button" className="link-btn" onClick={() => go('forgot')}>Forgot password?</button>
      ) : (
        !demo && (
          <p className="hint">
            Forgot your password? The server owner can reset it with <code>ADMIN_RESET_PASSWORD</code> (see the README).
          </p>
        )
      )}
    </Shell>
  );
}
