# CETU PACT API

PACT-BE is the backend service for the PACT tool. It validates LMS LTI launches, syncs LMS identities into MongoDB, manages PACT cohort and squad assignments, serves role/cohort-aware content, records progress and scores, publishes individual scores back to LMS AGS when a line item and AGS token are available, and exposes dashboard scoreboard data.

## Local development

Copy `.env.example` to `.env`, fill in the LMS/Keycloak/LTI values, then run:

```powershell
npm install
npm run db:ensure
npm run dev
```

## Deployment paths

PACT backend has two runtime layers:

- Node/Express origin service: owns MongoDB access, LTI validation, sessions, scores, and LMS AGS calls.
- Cloudflare Worker proxy: exposes the public API edge and forwards traffic to the Node origin.

Staging and production are intentionally separate.

| Target | Worker deploy command | Worker name | Origin URL | CORS origins |
| --- | --- | --- | --- | --- |
| Staging | `npm run deploy:worker:staging` | `cetu-pact-api-staging` | `https://pact-api-origin-staging.cetu.online` | `https://cetu-pact-web-staging.pages.dev,https://pact-staging.cetu.online` |
| Production | `npm run deploy:worker:production` | `cetu-pact-api` | `https://pact-api-origin.cetu.online` | `https://pact2.cetu.online,https://lms.cetu.online` |

The deploy scripts run `npm run build` and `npm test` before publishing. Worker names, origins, and CORS origins are defined in `wrangler.jsonc` under `env.staging` and `env.production`, so staging and production deploys use explicit Wrangler environments:

```powershell
npx wrangler deploy --env staging
npx wrangler deploy --env production
```

Use the npm scripts for the guarded path:

```powershell
npm run deploy:worker:staging
npm run deploy:worker:production
```

The staging Worker proxy requires the PACT Node origin to be reachable through the named Cloudflare Tunnel at `https://pact-api-origin-staging.cetu.online`. The production Worker proxy uses a separate origin hostname, `https://pact-api-origin.cetu.online`, so the public API hostname can point at the Worker without proxying back to itself. The PACT origin's `APP_BASE_URL` should still be the public API URL, `https://pact2-api.cetu.online`, because LTI and Deep Linking URLs are sent back to the LMS. Tunnel config lives outside the repo, for example:

```yaml
tunnel: 5a73f921-0f89-40fc-bbb9-e7220ff5c53f
credentials-file: C:\Users\CETUAdmin1\.cloudflared\5a73f921-0f89-40fc-bbb9-e7220ff5c53f.json

ingress:
  - hostname: pact-api-origin-staging.cetu.online
    service: http://127.0.0.1:4100
  - service: http_status:404
```

GitHub houses repository code only. Deployments are managed intentionally with Wrangler from an authenticated operator workstation or controlled deployment host.

The production origin can be started with:

```powershell
npm run build
.\scripts\start-production-origin.ps1
```

For staging hosts that must recover before interactive logon, install the origin and tunnel as real Windows services through NSSM:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-staging-services.ps1 -StartNow
```

This removes the older same-named scheduled tasks and obsolete local sink service, installs auto-start services named `PACT-Staging-Origin` and `PACT-Staging-Tunnel`, and configures NSSM to restart the processes if they exit. The script requires the Cloudflare tunnel config at `C:\Users\CETUAdmin1\.cloudflared\cetu-pact-api-staging.yml` unless `-CloudflaredConfigPath` is supplied.

Do not put Mongo credentials, LTI private keys, Keycloak secrets, or API tokens in frontend repositories or Cloudflare Pages variables.

## Importing PACT modules

Question-bank JSON files can be imported as published PACT modules. Each source file becomes one `pactContent` module with the full validated question payload stored server-side.

```powershell
npm run modules:import:production -- --course-id pact `
  "C:\Users\CETUAdmin1\Downloads\day1_lecture1_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day1_lecture2_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day2_lecture1_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day2_lecture2_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day3_lecture1_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day4_lecture1_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day4_lecture2_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day5_capstone_questions.json"
```

Use `modules:import:production` for production imports. It forces the production API URLs and the unprefixed Mongo collections before config is loaded, so it cannot inherit the staging `pact_staging_` collection prefix from a shared runtime env file. Use `--cohort-id <cohort>` only when modules should be scoped to a specific LMS cohort. The importer is idempotent and skips repeated question IDs.

## API surface

- `POST /api/v1/lti/launch` validates an LMS `id_token`, syncs the PACT user, and returns a PACT session token for a generic LMS course launch.
- `POST /launch/:contentType` validates a Deep Linked LMS resource launch and creates a PACT session scoped to `module`, `challenge`, `game`, or `assessment`.
- `POST /api/v1/lti/deep-link` validates an LMS Deep Linking launch and returns signed Deep Linking content items.
- `GET /api/v1/content` returns published modules, challenges, games, and assessments for launched learners. Administrator sessions can review all course content; instructor sessions can review all content in their launched cohort plus global course content.
- `POST /api/v1/scores` records a module, game, challenge, or assessment score and publishes to LMS AGS when possible.
- `GET /api/v1/dashboard/scoreboard` returns per-user score and progress summaries for the user's course/cohort/squad.
- `POST /api/v1/admin/squads` creates squads for a course cohort.
- `PATCH /api/v1/admin/users/:userId/squad` assigns a learner to a squad.
- `POST /api/v1/admin/content` creates or updates PACT content.
- `GET /api/v1/admin/content` lists course content for administrator/instructor gating.
- `PATCH /api/v1/admin/content/:contentId/status` changes content between `draft`, `published`, and `archived`.
- `GET /api/v1/admin/diagnostics/ags-token-context` reports whether the current launch has AGS score scope for server-side token acquisition.
- `GET /api/v1/admin/diagnostics/ags-publish-attempts` lists course-scoped AGS publish attempts for administrators and instructors.
- `GET /api/v1/admin/diagnostics/ags-publish-attempts/export.csv` exports filtered AGS publish attempts as CSV.
- `POST /api/v1/admin/diagnostics/ags-publish-attempts/process-due` manually processes due failed or pending AGS publish attempts for the launched course and records an audit event.
- `POST /api/v1/admin/diagnostics/ags-publish-attempts/:attemptId/retry` retries a failed or pending AGS publish attempt for the launched course.
- `POST /api/v1/ops/ags-publish-attempts/process-due` lets an external scheduler process due AGS publish attempts when `AGS_PROCESS_DUE_SCHEDULER_SECRET` is configured. Authenticate with `Authorization: Bearer <secret>`.

Protected PACT endpoints use the bearer session token returned from LTI launch. Squad administration requires `admin`; content gating requires `admin` or `instructor`.

## LMS integration contract

The canonical LMS tool registration should use the public PACT API origin:

- Redirect URI: `<PACT_API_BASE_URL>/api/v1/lti/launch`
- Deep Linking redirect URI: `<PACT_API_BASE_URL>/api/v1/lti/deep-link`
- Target link URI: `<PACT_API_BASE_URL>/launch`

Deep-linked content items generated by PACT target:

- `<PACT_API_BASE_URL>/launch/module`
- `<PACT_API_BASE_URL>/launch/challenge`
- `<PACT_API_BASE_URL>/launch/game`
- `<PACT_API_BASE_URL>/launch/assessment`

PACT validates LMS launch tokens server-side before creating a PACT user/session. Required launch claims include issuer, audience, signature, expiration, deployment ID, LTI version `1.3.0`, message type, context ID, target link URI, and resource link ID for resource launches.

The `target_link_uri` claim must use the configured `APP_BASE_URL` origin and one of the known launch/deep-link paths. Legacy `/lti/launch` and `/lti/deep-link` target paths are temporarily accepted for older registrations while `PACT_ALLOW_LEGACY_LTI_PATHS=true`. Set `PACT_ALLOW_LEGACY_LTI_PATHS=false` after all deployed LMS registrations are migrated to canonical `/api/v1/lti/...` URLs, then remove the compatibility branch in code after a clean staging cycle.

Score submissions create PACT score/progress records. Question-based assignment finalization waits until the server-side completion policy returns `complete`, then records the final PACT score and enqueues a durable LMS AGS publish attempt. When content has a line item URL, PACT uses stored LTI AGS launch context to request a short-lived LMS AGS score token server-side through `/api/v1/lti/token` during queue processing. If server-side token acquisition is unavailable, the retry endpoint can still accept a current operator-supplied AGS access token as a fallback. Identical already-published scores are not reposted; changed scores are published again. Each publish, pending/not-applicable outcome, failure, duplicate skip, automatic retry, manual queue processing, and admin retry is recorded in `pactAgsPublishAttempts` or `pactAuditEvents` without storing AGS access tokens. Durable retries after restart are supported when the original launch granted AGS score scope and PACT has its tool private key configured.

See `docs/assignment-scoring-and-ags-policy.md` for optional-question behavior, attempt limits, manual grading, must-pass gates, and AGS publish timing. See `docs/production-readiness-checklist.md` for staging validation, production environment verification, audit visibility, and AGS queue operations.

AGS retry and retention behavior is controlled by:

- `AGS_AUTO_RETRY_ENABLED`
- `AGS_AUTO_RETRY_MAX_ATTEMPTS`
- `AGS_AUTO_RETRY_INITIAL_DELAY_MS`
- `AGS_AUTO_RETRY_MAX_DELAY_MS`
- `AGS_ATTEMPT_RETENTION_DAYS`
- `AGS_RETENTION_CLEANUP_INTERVAL_MS`
- `AGS_RETRY_EXHAUSTED_WEBHOOK_URLS`
- `AGS_RETRY_EXHAUSTED_WEBHOOK_BEARER_TOKEN`
- `AGS_RETRY_EXHAUSTED_WEBHOOK_MAX_ATTEMPTS`
- `AGS_RETRY_EXHAUSTED_WEBHOOK_INITIAL_DELAY_MS`
- `AGS_RETRY_EXHAUSTED_WEBHOOK_MAX_DELAY_MS`
- `AGS_PROCESS_DUE_SCHEDULER_SECRET`

Exhausted retry notifications are persisted in `pactNotifications` before delivery. Failed sink delivery is retried with exponential backoff and moved to `dead_letter` after the configured max attempts.

Staging and production use the Cloudflare-hosted `cetu-ops-webhook` receiver for exhausted retry notifications. Staging may include the provider's forced-failure route for dead-letter verification; production must only use the success route.

For non-server runtimes, configure an external scheduler to call:

```bash
curl -X POST "$PACT_API_BASE_URL/api/v1/ops/ags-publish-attempts/process-due" \
  -H "authorization: Bearer $AGS_PROCESS_DUE_SCHEDULER_SECRET" \
  -H "content-type: application/json" \
  -d '{"limit":25}'
```

The scheduler endpoint is not tied to a browser launch session. It scans due queue items globally, uses stored AGS launch context for token acquisition, and does not write instructor audit events. Instructor/admin manual processing remains course-scoped and audited through `/api/v1/admin/diagnostics/ags-publish-attempts/process-due`.
