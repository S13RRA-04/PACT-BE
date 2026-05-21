# Assignment Scoring and AGS Policy

This document describes the production scoring rules used by PACT question-based content and when final results are published to LMS AGS.

## Completion Policy

PACT evaluates assignment completion server-side after each question attempt and after instructor manual grading. The frontend displays the returned state, but it does not decide completion.

- `complete`: all required completion gates are satisfied.
- `pending_manual`: at least one required manual-grading question has been submitted and still needs instructor grading.
- `failed_must_pass`: a required must-pass question has been exhausted or graded incorrect.
- `in_progress`: required questions are still unanswered or still have attempts remaining.

## Optional Questions

Questions with `scoring.optional: true` are excluded from required completion. A learner can complete the assignment without answering them.

Current production policy: optional questions do not contribute bonus points to the final score. They remain practice/enrichment questions unless product policy changes and the scoring policy is updated deliberately.

## Attempt Limits

`scoring.maxAttempts` controls how many times a learner can submit a question.

- Missing `maxAttempts` means unlimited attempts.
- Exhausted required questions block completion when they are not correct.
- Exhausted optional questions do not block completion.
- A learner cannot bypass attempt limits by resubmitting from the frontend; enforcement is server-side.

## Must-Pass Gating

Questions with `scoring.mustPass: true` are hard completion gates.

- Automatic questions must evaluate as correct.
- Manual questions must be graded correct by the instructor.
- Partial manual credit contributes to the numeric score, but it does not satisfy must-pass unless it is full credit under the current policy.

## Manual Grading

Questions with `scoring.gradingMode: "manual"` enter `pending_manual` when submitted.

Instructor grading:

- Updates or creates the manual grade record for the attempt.
- Stores score, max score, correctness, feedback, grader, and grading timestamp.
- Writes an audit event for grading history.
- Re-runs the same completion policy used by learner submissions.

Partial manual scores count in the final numeric score. `isCorrect` is true only when the instructor awards full credit, which keeps must-pass grading strict and auditable.

## Final Score and AGS Timing

PACT publishes LMS AGS only after the assignment completion policy returns `complete`.

The learner-facing finalization path records the PACT score and creates a durable AGS publish attempt. The LMS publish is then processed through the AGS queue rather than being required to succeed in the learner request.

AGS outcomes:

- `pending`: final score is saved and queued for LMS grade sync.
- `published`: LMS AGS accepted the score.
- `failed`: LMS AGS publish failed and can be retried.
- `retry_exhausted`: automatic retry attempts were exhausted.
- `not_applicable`: no LMS line item is available.
- `skipped_duplicate`: an identical score was already published.

Automatic queue processing is handled by the backend maintenance service where a long-running runtime is available. Non-server runtimes can use the admin/instructor endpoint:

`POST /api/v1/admin/diagnostics/ags-publish-attempts/process-due`

Manual processing is course-scoped to the launch session and writes an audit event with scanned, retried, failed, exhausted, and limit counts.

External schedulers can use:

`POST /api/v1/ops/ags-publish-attempts/process-due`

Completed-submission AGS backfill also runs through the scheduler path:

`POST /api/v1/ops/ags-publish-attempts/backfill-completed`

This endpoint requires `Authorization: Bearer <AGS_PROCESS_DUE_SCHEDULER_SECRET>` and a `courseId` body field. It processes bounded batches, excludes scores already pending or published, and returns `remainingCandidates` so operators can see whether another scheduled batch is needed. These ops endpoints are intended for cron-like production operations where no instructor browser session exists.
