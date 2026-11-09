# Lead & Support Engine — independent rebuild

Rebuild of the Muse fullstack app `lead-support-engine` as an independent app
at https://leads.dvaughnhouse.com. The Muse original stays live and untouched.

## Hosting

- **Worker** `lead-support-engine-api` (API + D1 binding, workers.dev) — `wrangler.toml`, `worker/src/index.js`
- **Pages** `lead-support-engine` (static SPA) — `public/`, custom domain `leads.dvaughnhouse.com`
- **D1** `lead-support-engine` (`c91e48ee-88a9-4d17-80b4-b35ecb29cca8`)

The SPA calls the Worker at its workers.dev URL (see `public/config.js`).

## Auth

Single shared password, stored ONLY as the `APP_PASSWORD` Worker secret
(`wrangler secret put APP_PASSWORD`). Login POSTs to the Worker, which sets an
HttpOnly `lse_session` cookie (HMAC, 30 days). Every `/api/*` route except
`/api/health`, `/api/login`, `/api/me` returns 401 without a valid session.

## Contact provider: STUB ONLY (spec §6.4)

Reveal returns the contact already held in the seed record, counts once, logs
the reveal, costs $0. No real contact-data API key exists; none is fetched or
invented. Reveals are counted, not deliverability-verified.

## Seed data

`scripts/seed.py` generates `seed.sql` verbatim from the Muse snapshot
`~/workspace/your_files/muse-backup-2026-11-08/lead-support-engine/data-snapshot-getoverview.json`:
15 leads (11 live + 4 alternates), 3 KB pages, 1 do-not-contact entry
(The Gerdsen Co., permanently closed), 2 reveals, $50/mo budget cap.

## Deploy

```bash
export PATH=~/workspace/.npm-global/bin:$PATH
# Worker + migrations + seed
python3 /tmp/cfw.py deploy
python3 /tmp/cfw.py d1 execute lead-support-engine --remote --file migrations/0001_schema.sql
python3 scripts/seed.py
python3 /tmp/cfw.py d1 execute lead-support-engine --remote --file seed.sql
# Frontend (handles the API token; run from inside public/)
python3 ~/workspace/custom-connectors/custom.legacy-cloudflare/bin/pages_wrangler_deploy.py \
  --project lead-support-engine --dir ~/workspace/repos/lead-support-engine/public
# Custom domain (once)
python3 /tmp/cfw.py pages domain add leads.dvaughnhouse.com --project-name lead-support-engine
```

## Tabs

- **Pipeline** — 13-stage lifecycle (discovered → scored → contact_revealed →
  staged → approved → sent → replied → fit_call → won → supported; terminal:
  disqualified / closed / suppressed), fit scoring (transparent rule-based
  rubric; already-scored leads keep their score), stub reveal, first-touch
  staging.
- **Approvals** — staged leads await an explicit approve/reject of the exact
  message and recipient. Nothing sends without it.
- **Support** — KB-grounded lookup (answers only from KB pages; unknown
  questions go to the unanswered list), support chats with human handoff
  (billing/person), inbound capture onto the shared lead record.
- **Setup & Seam** — stub provider, $50/mo budget cap, reveal log, absolute
  do-not-contact list, ICP text.
