# CETU PACT API

PACT-BE is the backend service for the PACT tool. It validates LMS LTI launches, syncs LMS identities into MongoDB, manages PACT cohort and squad assignments, serves role/cohort-aware content, records progress and scores, publishes individual scores back to LMS AGS when a line item and AGS token are available, and exposes dashboard scoreboard data.

## Local development

Copy `.env.example` to `.env`, fill in the LMS/Keycloak/LTI values, then run:

```powershell
npm install
npm run db:ensure
npm run dev
```

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
