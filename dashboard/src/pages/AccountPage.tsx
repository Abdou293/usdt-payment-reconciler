import { useState } from 'react';
import { api, type SessionInfo } from '../api';
import { Card, ErrorNote } from '../ui';

export function AccountPage({ session }: { session: SessionInfo }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const isDemo = session.mode === 'demo';

  return (
    <>
      <header className="page-head">
        <h1>Account</h1>
        <p className="muted">Signed in as {session.username}.</p>
      </header>
      <div className="narrow">
        <Card title="Change password">
          {isDemo ? (
            <p className="hint">
              Turned off in the public demo: every visitor shares this account, so a change would lock the others out.
              In a real installation the admin changes the password here.
            </p>
          ) : (
            <form
              className="stack-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                setDone(false);
                if (next !== confirm) {
                  setError('The two new passwords do not match');
                  return;
                }
                setBusy(true);
                try {
                  await api.changePassword(current, next);
                  setCurrent('');
                  setNext('');
                  setConfirm('');
                  setDone(true);
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Current password
                <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required maxLength={256} />
              </label>
              <label>
                New password (12+ characters)
                <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={12} maxLength={128} />
              </label>
              <label>
                Repeat new password
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required minLength={12} maxLength={128} />
              </label>
              <ErrorNote message={error} />
              {done && <p className="ok-note">Password changed. Every other signed-in device was logged out.</p>}
              <div className="form-actions">
                <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
              </div>
            </form>
          )}
        </Card>
        <Card title="Lost access?">
          <p className="hint">
            {isDemo
              ? 'In a real installation, "Forgot password?" on the sign-in page sends a one-time code to the admin Telegram chat.'
              : session.password_reset_available
                ? 'Use "Forgot password?" on the sign-in page: a one-time code is sent to the admin Telegram chat.'
                : 'Forgot-password by Telegram is off (it needs TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID).'}{' '}
            The server owner can always reset the password by setting <code>ADMIN_RESET_PASSWORD</code> and restarting.
          </p>
        </Card>
      </div>
    </>
  );
}
