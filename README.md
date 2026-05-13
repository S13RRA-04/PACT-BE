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

Do not put Mongo credentials, LTI private keys, Keycloak secrets, or API tokens in frontend repositories or Cloudflare Pages variables.

## Importing PACT modules

Question-bank JSON files can be imported as published PACT modules. Each source file becomes one `pactContent` module with the full validated question payload stored server-side.

```powershell
$env:DOTENV_CONFIG_PATH=".env.pact-origin-runtime"
npm run modules:import -- --course-id pact `
  "C:\Users\CETUAdmin1\Downloads\day1_lecture1_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day1_lecture2_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day2_lecture1_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day2_lecture2_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day3_lecture1_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day4_lecture1_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day4_lecture2_questions.json" `
  "C:\Users\CETUAdmin1\Downloads\day5_capstone_questions.json"
```

Use `--cohort-id <cohort>` when modules should be scoped to a specific LMS cohort. The importer is idempotent and skips repeated question IDs.

## API surface

- `POST /api/v1/lti/launch` validates an LMS `id_token`, syncs the PACT user, and returns a PACT session token.
- `GET /api/v1/content` returns published modules, challenges, and games for the launched user role and cohort.
- `POST /api/v1/scores` records a module/game/challenge score and publishes to LMS AGS when possible.
- `GET /api/v1/dashboard/scoreboard` returns per-user score and progress summaries for the user's course/cohort/squad.
- `POST /api/v1/admin/squads` creates squads for a course cohort.
- `PATCH /api/v1/admin/users/:userId/squad` assigns a learner to a squad.
- `POST /api/v1/admin/content` creates or updates PACT content.
- `GET /api/v1/admin/content` lists course modules for administrator/instructor gating.
- `PATCH /api/v1/admin/content/:contentId/status` changes a module between `draft`, `published`, and `archived`.

Protected PACT endpoints use the bearer session token returned from LTI launch. Squad administration requires `admin`; content gating requires `admin` or `instructor`.
