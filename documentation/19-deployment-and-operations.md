# 19 · Deployment and operations

This chapter covers running the Node.js server (Docker or directly). To run on Cloudflare Workers with a Durable
Object database instead, see [25 Running on Cloudflare](25-cloudflare.md).

## Option A: Docker

```bash
docker build -t saral-erp .
docker volume create saral-data
docker run -d --name saral -p 4000:4000 -v saral-data:/data \
  -e SMTP_HOST=smtp.example.com -e SMTP_USER=… -e SMTP_PASSWORD=… -e SMTP_FROM='Accounts <accounts@example.com>' \
  saral-erp
docker logs saral          # shows the first-run setup code
```

The image (`Dockerfile`) builds both packages, installs only the server's production dependencies, runs as the
unprivileged `node` user, stores the database at `/data/saral.db` (declare a volume), exposes port 4000 and has a
health check on `/api/health`.

Unattended setup instead of the setup screen:

```bash
docker run -d -p 4000:4000 -v saral-data:/data \
  -e ADMIN_EMAIL=owner@example.com -e ADMIN_PASSWORD='a long password' \
  -e ORG_NAME='Acme Industries' -e ORG_STATE_CODE=27 -e ORG_GSTIN=27AAAAA0000A1Z5 saral-erp
```

## Option B: Node directly

```bash
npm ci
npm run build
DB_FILE=/var/lib/saral/saral.db PORT=4000 npm start
```

Run it under a process manager (systemd, pm2) with restart on failure. Example systemd unit:

```ini
[Unit]
Description=Saral ERP
After=network.target

[Service]
User=saral
WorkingDirectory=/opt/saral/server
Environment=NODE_ENV=production DB_FILE=/var/lib/saral/saral.db PORT=4000 TRUST_PROXY=loopback
ExecStart=/usr/bin/node --no-warnings dist/index.js
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

## Reverse proxy and TLS

Put the app behind HTTPS (nginx, Caddy, a cloud load balancer). Set `TRUST_PROXY` (e.g. `loopback` or `1`) so sign-in
throttling sees the real client IP from `X-Forwarded-For`; without it, all clients appear as the proxy. Example nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name erp.example.com;
  client_max_body_size 12m;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  add_header Strict-Transport-Security "max-age=31536000" always;
}
```

## First start

1. Start the server and read the setup code from the log (`First-run setup: … setup code: XXXX-XXXX-XXXX`).
2. Open the site, enter the code, organisation details and the administrator account.
3. In Settings: complete the organisation address/PIN (needed for e-invoices and e-way bills), warehouses with
   address/PIN/state, taxes, numbering prefixes, payroll settings for your states (professional tax slabs are preset
   only for Karnataka), currencies and exchange rates if you trade in foreign currency.
4. Add users (they choose their own password at first sign-in) and roles.
5. Enter opening balances: item opening stock and contact opening balances are dated on the opening balance date;
   other opening balances (bank, capital, loans) with a manual journal against "Opening Balance Adjustments".

## Backups

- **From the app**: Settings → System & Backup → Download backup (administrators). Uses SQLite `VACUUM INTO`, so the
  copy is consistent even while the server is running.
- **From the server**: copy the file safely with SQLite's backup, e.g.
  `sqlite3 /var/lib/saral/saral.db ".backup '/backups/saral-$(date +%F).db'"`, or stop the service and copy
  `saral.db` (plus `-wal`/`-shm` if present).
- Keep daily copies off the server and test a restore regularly. Backups contain all business data and password
  hashes: store them encrypted with restricted access.

**Restore**: stop the server, replace the database file with the backup (remove stale `-wal`/`-shm`), start the
server. Migrations run automatically if the backup came from an older version.

## Upgrades

1. Take a backup.
2. Deploy the new version (new image or `git pull && npm ci && npm run build`).
3. Restart. `migrate()` applies pending migrations in transactions and logs nothing on success; a failed migration
   rolls back and the server exits with the error. A database from a newer version is refused.
4. Check `GET /api/health` → `schema_version` and Settings → System.

Rollback: restore the backup taken in step 1 and start the previous version.

## Email

Configure `SMTP_HOST`, `SMTP_PORT` (587 default; 465 implies TLS), `SMTP_SECURE=1` (TLS from the start),
`SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`. Delivery status per message is in Settings → Email Log, where unsent
messages can be retried.

## Monitoring

- Health: `GET /api/health` (no auth) → `{ ok, time, schema_version }`.
- Logs (stdout/stderr): start-up, setup code, scheduled-job failures, unexpected errors with a reference id that is
  also shown to the user, SIGTERM/SIGINT shutdown.
- Watch for: repeated 500s, `Scheduled job failed`, email `failed` rows, recurring-invoice failure notifications.

## Shutdown

On SIGTERM/SIGINT the server stops accepting connections, waits for in-flight requests (up to 10 seconds), closes the
database cleanly and exits.

## Capacity notes

SQLite in WAL mode handles many concurrent readers and one writer; requests are short and synchronous. A single
instance comfortably serves a small/mid-sized company. Do not run two server processes against the same database
file. Large back-dated changes re-value item histories and can take longer; schedule bulk imports outside busy hours.
