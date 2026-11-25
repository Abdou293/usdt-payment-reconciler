# Order state machine

```mermaid
stateDiagram-v2
    [*] --> pending: order created (unique payable amount)
    pending --> detected: matching transfer seen (0 confirmations)
    pending --> expired: no payment before expiresAt
    detected --> confirming: 1..N-1 confirmations
    confirming --> confirmed: N confirmations, amount within tolerance
    confirming --> underpaid: N confirmations, total too low
    confirming --> overpaid: N confirmations, total too high
    detected --> pending: payment removed by reorg
    confirming --> pending: payment removed by reorg
    expired --> late_payment: payment mined after expiresAt
    expired --> confirming: in-time payment found after the server slept
    underpaid --> confirmed: admin assigns a top-up payment
    overpaid --> confirmed: admin accepts (manual review)
    late_payment --> confirmed: admin accepts (manual review)
    confirmed --> [*]
```

Payment (deposit) statuses: `matched`, `unmatched` (review queue), `wrong_token`, `orphaned` (removed by a reorg).

Rules enforced in code (`src/core/stateMachine.ts`, `src/core/status.ts`):

- Every transition is validated; illegal ones are refused and logged as `transition_blocked`.
- `confirmed` is final. A reorg deeper than the required confirmations does **not** silently
  un-confirm an order: it raises a critical `reorg_after_final` alert for a human.
- Only orders in the review queue (`underpaid`, `overpaid`, `late_payment`) can be accepted manually,
  and a written reason is required. Every change is recorded in the append-only `audit_log` table.
- Idempotency key for a transfer: `(network, tx_hash, log_index)`.
