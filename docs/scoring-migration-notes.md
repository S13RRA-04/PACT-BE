# PACT Scoring Migration Notes

These defaults keep existing content compatible when production question documents do not yet include the newer scoring policy fields.

## Question Scoring Defaults

- `scoring.optional`: missing values should be treated as `false`.
- `scoring.gradingMode`: missing values should be treated as `automatic`.
- `scoring.maxAttempts`: missing values mean unlimited attempts.
- `scoring.mustPass`: missing values should be backfilled to `false` for schema consistency.
- `scoring.points`: required for scoring. Any production question without `points` needs a content repair before final score publishing is enabled.

## Policy Decisions

- Optional questions remain excluded from final assignment score and max score. They can collect practice evidence and feedback without changing the LMS gradebook outcome.
- Partial manual scores count toward the numeric final score, but `isCorrect` is `true` only when the instructor awards full credit. This keeps must-pass gating strict and auditable.
- Manual grading changes are recorded as `question.manual_grade.upserted` audit events with score deltas and identifiers only. Free-text feedback is not copied into audit metadata.

## Backfill Outline

Run the dry-run capable migration before applying changes:

```powershell
npm run db:migrate:scoring -- --dry-run
npm run db:migrate:scoring -- --courseId=pact-course-id --dry-run
npm run db:migrate:scoring -- --apply
```

The script preserves existing scoring fields, reports questions missing `points`, and only writes default `mustPass`, `optional`, and `gradingMode` values when `--apply` is provided.

## AGS Publishing

Finalization now records the PACT score and persists a durable AGS publish attempt after the assignment completion policy returns `complete`. LMS grade publishing is processed from the AGS queue by the backend maintenance service, by manual instructor/admin processing in non-server runtimes, or by a future external scheduler that calls the same protected processing path.
