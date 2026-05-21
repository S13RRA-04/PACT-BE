# Production Readiness Checklist

Use this checklist before enabling PACT question completion, manual grading, and AGS publishing in production.

## Staging E2E Validation

- Launch PACT from LMS as a learner with AGS score scope.
- Complete automatic, optional, manual, and must-pass question paths.
- Confirm pending manual grade survives reload through `GET /api/v1/content/:contentId/completion`.
- Grade a manual attempt as an instructor and confirm the same completion policy re-runs.
- Confirm final score is saved in PACT and AGS status becomes `pending`.
- Process the AGS queue and confirm LMS receives the learner score.
- Force an AGS failure and confirm `failed`, manual retry, and `retry_exhausted` states are visible.

## Production Environment Verification

- `APP_BASE_URL`, `PACT_API_BASE_URL`, and frontend API origins use production HTTPS URLs.
- MongoDB URI and collection prefix target production only.
- LTI issuer, client ID, deployment ID, JWKS URL, and private key match the LMS production tool registration.
- AGS token and score scopes are granted by production LMS launches.
- Session secrets and LTI keys are production values and are not shared with staging.
- `PACT_ALLOW_LEGACY_LTI_PATHS` is disabled after LMS registrations use canonical `/api/v1/lti/...` paths.
- Notification sink URLs and bearer token are production-specific.

## Audit Visibility

- Manual grading writes `question.manual_grade.upserted` audit events.
- Manual AGS queue processing writes `ags.queue.process_due.triggered` audit events.
- Production operators can query or export those events for compliance review.
- Audit retention expectations are documented before cleanup jobs are enabled.

## AGS Queue Operations

- Long-running Node runtimes should enable `AGS_AUTO_RETRY_ENABLED`.
- Non-server runtimes need operational paths for `POST /api/v1/ops/ags-publish-attempts/process-due` and `POST /api/v1/ops/ags-publish-attempts/backfill-completed` using `AGS_PROCESS_DUE_SCHEDULER_SECRET`.
- Operators must launch PACT from the LMS with AGS score scope before relying on server-side token acquisition.
- `retry_exhausted` alerts are delivered to the configured operations webhook.
- Manual retry is available for failed or pending attempts without storing AGS access tokens.

External scheduler smoke check:

```bash
curl -X POST "$PACT_API_BASE_URL/api/v1/ops/ags-publish-attempts/process-due" \
  -H "authorization: Bearer $AGS_PROCESS_DUE_SCHEDULER_SECRET" \
  -H "content-type: application/json" \
  -d '{"limit":25}'

curl -X POST "$PACT_API_BASE_URL/api/v1/ops/ags-publish-attempts/backfill-completed" \
  -H "authorization: Bearer $AGS_PROCESS_DUE_SCHEDULER_SECRET" \
  -H "content-type: application/json" \
  -d '{"courseId":"pact","limit":50}'
```

Expected queue response shape: `{"scanned":0,"retried":0,"failed":0,"exhausted":0}` or non-zero counts when due queue items exist. Expected backfill response includes `remainingCandidates`; repeat scheduled batches until it reaches `0`.

## Go/No-Go

Do not enable production grade publishing until staging E2E validation, production environment verification, audit visibility, and AGS queue operations are all complete.
