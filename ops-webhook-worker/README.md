# CETU Ops Webhook Receiver

Small Cloudflare Worker used as the PACT AGS exhausted-retry notification receiver.
It also provides external scheduler paths for processing due PACT AGS queue attempts and backfilling completed submissions when the PACT backend is deployed in a non-server runtime.

Routes:

- `GET /health`
- `GET /alerts?limit=50`
- `POST /pact-ags-process-due?limit=25`
- `POST /pact-ags-backfill-completed?courseId=pact&cohortId=optional&limit=50`
- `POST /ags-retry-exhausted`
- `POST /ags-retry-exhausted-fail` for staging-only dead-letter verification

All routes except `/health` require:

```text
Authorization: Bearer <OPS_WEBHOOK_BEARER_TOKEN>
```

Accepted alerts are stored in the `ALERTS_KV` binding for 90 days so ops can inspect recent deliveries without relying on Worker logs.
The scheduled trigger runs every five minutes and calls PACT `POST /api/v1/ops/ags-publish-attempts/process-due` and, when `AGS_BACKFILL_COURSE_ID` is configured, `POST /api/v1/ops/ags-publish-attempts/backfill-completed` with `AGS_PROCESS_DUE_SCHEDULER_SECRET`. The manual `/pact-ags-process-due` and `/pact-ags-backfill-completed` routes use the same protected PACT ops paths and are protected by `OPS_WEBHOOK_BEARER_TOKEN`.

Deploy:

```powershell
npx wrangler deploy --config ops-webhook-worker/wrangler.jsonc --env staging
npx wrangler secret put OPS_WEBHOOK_BEARER_TOKEN --config ops-webhook-worker/wrangler.jsonc --env staging
npx wrangler secret put PACT_API_BASE_URL --config ops-webhook-worker/wrangler.jsonc --env staging
npx wrangler secret put AGS_PROCESS_DUE_SCHEDULER_SECRET --config ops-webhook-worker/wrangler.jsonc --env staging
npx wrangler secret put AGS_BACKFILL_COURSE_ID --config ops-webhook-worker/wrangler.jsonc --env staging

npx wrangler deploy --config ops-webhook-worker/wrangler.jsonc --env production
npx wrangler secret put OPS_WEBHOOK_BEARER_TOKEN --config ops-webhook-worker/wrangler.jsonc --env production
npx wrangler secret put PACT_API_BASE_URL --config ops-webhook-worker/wrangler.jsonc --env production
npx wrangler secret put AGS_PROCESS_DUE_SCHEDULER_SECRET --config ops-webhook-worker/wrangler.jsonc --env production
npx wrangler secret put AGS_BACKFILL_COURSE_ID --config ops-webhook-worker/wrangler.jsonc --env production
```
