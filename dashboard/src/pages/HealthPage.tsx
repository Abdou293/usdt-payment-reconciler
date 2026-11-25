import { useEffect } from 'react';
import { api, type SessionInfo } from '../api';
import { Card, Empty, ErrorNote, fmtTime, useAsync } from '../ui';

export function HealthPage({ session }: { session: SessionInfo }) {
  const { data, error, reload } = useAsync(() => api.health(), []);
  useEffect(() => {
    const t = setInterval(() => void reload(), 10_000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <>
      <header className="page-head">
        <h1>System health</h1>
        <p className="muted">Chain watchers and notification delivery. Refreshes every 10 seconds.</p>
      </header>
      <ErrorNote message={error} />
      {data && (
        <>
          <div className="grid-2">
            {data.watchers.map((w) => (
              <Card key={w.network} title={<>{w.label} <span className={`dot ${w.healthy ? 'dot-good' : 'dot-bad'}`} aria-label={w.healthy ? 'healthy' : 'unhealthy'} /></>}>
                <dl className="facts">
                  <dt>Status</dt>
                  <dd>{w.healthy ? 'Healthy' : 'Stale or failing'}</dd>
                  <dt>Scanned up to block</dt>
                  <dd className="mono">{w.cursor_block ?? '—'}</dd>
                  <dt>Chain tip</dt>
                  <dd className="mono">{w.latest_block ?? '—'}{w.lag_blocks !== null && <span className="muted"> (lag {w.lag_blocks})</span>}</dd>
                  <dt>Confirmations required</dt>
                  <dd>{w.required_confirmations}</dd>
                  <dt>Last successful poll</dt>
                  <dd>{fmtTime(w.last_success_at)}</dd>
                  <dt>Token contract</dt>
                  <dd className="mono break">{w.token_contract}</dd>
                  <dt>Watched addresses</dt>
                  <dd className="mono break">{w.watch_addresses.join(', ')}</dd>
                  {w.last_error && (
                    <>
                      <dt>Last error</dt>
                      <dd className="error-text">{w.last_error}</dd>
                    </>
                  )}
                </dl>
              </Card>
            ))}
          </div>

          <Card title="Notifications (Telegram + webhook)">
            <div className="status-row">
              {Object.keys(data.deliveries).length === 0 && <span className="muted">No notifications queued yet.</span>}
              {Object.entries(data.deliveries).map(([s, c]) => (
                <span key={s} className="chip">{s}: <strong>{c}</strong></span>
              ))}
            </div>
            {data.failed_deliveries.length === 0 ? (
              <Empty>No permanently failed deliveries.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>When</th><th>Channel</th><th>Attempts</th><th>Last error</th></tr></thead>
                  <tbody>
                    {data.failed_deliveries.map((d) => (
                      <tr key={d.id}><td>{fmtTime(d.created_at)}</td><td>{d.channel}</td><td>{d.attempts}</td><td className="small">{d.last_error}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <p className="hint">
            Mode: <strong>{session.mode}</strong>. This service only watches public addresses. It never holds keys or moves funds.
            Checked {fmtTime(data.checked_at)}.
          </p>
        </>
      )}
    </>
  );
}
