# 20 · Security

A summary of the controls in place, where they live, and what operators must do.

## Controls

| Area | Control | Where |
|---|---|---|
| Installation | One-time setup code required to create the first administrator; setup closes once a user exists; no built-in accounts or passwords | `seed.ts`, `app.ts` |
| Former defaults | Migration 2 flags accounts still using a former built-in password; they must change it before using anything | `migrations.ts`, `auth.ts` |
| Passwords | scrypt with per-user salt, constant-time comparison, 8–200 characters; administrator-set passwords must be changed at first sign-in | `auth.ts` |
| Sessions | 256-bit random bearer tokens, header only (never in URLs), 7-day expiry, purged hourly; logout deletes; password change, deactivation, role change and reset revoke sessions | `auth.ts`, `app.ts` |
| Brute force | Per email+IP, per email and per IP failure limits (429) with bounded tracking; email+IP pairs that signed in before are exempt from the per-IP limit (no mass lockout behind a shared address); wrong current passwords on password change limited per user; uniform timing for unknown emails | `auth.ts` |
| Authorisation | Module × action permissions on every route; document actions check their own permission; user/role management and backups are administrator-only; at least one active administrator always remains | `app.ts`, `auth.ts` |
| Input | All business input validated server-side; SQL uses bound parameters everywhere; identifiers in dynamic SQL come from code, never from input | all services |
| Output | JSON API; React escapes rendered text; CSV exports neutralise spreadsheet formulas | `reports.ts`, `DataTable.tsx` |
| Headers | CSP (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`; `X-Powered-By` removed | `app.ts` |
| Errors | Unexpected errors return a generic message and a reference id; details only in server logs | `app.ts` |
| Outbound calls | Workflow webhooks only to public addresses, checked in the connection's own DNS lookup (no rebinding window), including IPv6 forms that embed IPv4; 10 s timeout, no redirects | `activity.ts` |
| Email | Delivered after the transaction commits; never sent twice; failures recorded | `activity.ts` |
| Integrity | Transactions for every write; locked periods; reconciled entries protected; audit log of changes | `db.ts`, `settings.ts`, `ledger.ts`, `activity.ts` |
| Upload size | JSON/CSV bodies limited to 10 MB | `app.ts` |
| Container | Runs as non-root `node` user; only production dependencies | `Dockerfile` |

## Operator checklist

- Serve only over HTTPS; set `TRUST_PROXY` correctly behind a proxy.
- Keep the setup code private until setup is done (it is printed in the server log).
- Restrict who can read server logs and backups; encrypt backups.
- Give users the least-privileged role; review roles and active users periodically (Settings → Users shows last
  sign-in).
- Keep `WEBHOOK_ALLOW_PRIVATE` unset unless webhooks must reach internal systems.
- Apply upgrades promptly; run `npm audit` as part of maintenance.

## Known gaps (see [23](23-limitations-and-roadmap.md))

- No multi-factor authentication or single sign-on yet.
- No per-record (row-level) permissions; access is per module.
- Login throttling state is in memory: it resets on restart and is not shared between several server processes.
- An egress firewall is still recommended for strict environments (defence in depth for webhooks).
- Session tokens are stored in the browser's `localStorage`; the strict CSP limits script injection, but an
  HttpOnly-cookie session would be stronger.
