import { z } from "zod";

export const ltiLaunchSchema = z.object({
  id_token: z.string().min(1)
});

export const ltiDeepLinkSchema = z.object({
  id_token: z.string().min(1)
});

export const squadCreateSchema = z.object({
  courseId: z.string().min(1),
  cohortId: z.string().min(1),
  name: z.string().min(1).max(120)
});

export const squadAssignmentSchema = z.object({
  squadId: z.string().uuid().optional(),
  squadNumber: z.enum(["1", "2", "3", "4"]).optional()
}).refine((value) => value.squadId || value.squadNumber, {
  message: "squadId or squadNumber is required"
});

export const contentCreateSchema = z.object({
  id: z.string().optional(),
  courseId: z.string().min(1),
  cohortId: z.string().min(1).optional(),
  role: z.enum(["admin", "instructor", "learner", "all"]).default("all"),
  type: z.enum(["module", "challenge", "game", "assessment"]),
  title: z.string().min(1).max(200),
  lmsLabel: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(4000),
  maxScore: z.number().nonnegative(),
  lineItemUrl: z.string().url().optional(),
  status: z.enum(["draft", "published", "archived"]).default("draft")
});

export const contentStatusUpdateSchema = z.object({
  status: z.enum(["draft", "published", "archived"])
});

export const contentAssignmentUpdateSchema = z.object({
  cohortId: z.string().min(1).nullable()
});

export const contentLmsLabelUpdateSchema = z.object({
  lmsLabel: z.string().min(1).max(200).nullable()
});

export const scoreSubmitSchema = z.object({
  contentId: z.string().min(1),
  score: z.number().nonnegative(),
  maxScore: z.number().positive().optional(),
  progressPercent: z.number().min(0).max(100).default(100),
  agsAccessToken: z.string().optional()
});

const answerValueSchema = z.union([
  z.string().max(4000),
  z.array(z.string().max(200)).max(100),
  z.record(z.string().max(200), z.string().max(4000)),
  z.boolean()
]);

export const contentProgressUpdateSchema = z.object({
  answers: z.record(z.string().min(1).max(200), answerValueSchema).optional(),
  progressPercent: z.number().min(0).max(100).optional(),
  status: z.enum(["not_started", "in_progress", "submitted"]).optional()
});

export const questionAttemptSubmitSchema = z.object({
  answer: answerValueSchema,
  feedbackExposed: z.boolean().default(true)
});

export const manualQuestionGradeSchema = z.object({
  score: z.number().nonnegative(),
  feedback: z.string().max(4000).optional()
});

export const questionAttemptQuerySchema = z.object({
  cohortId: z.string().min(1).optional(),
  contentId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  questionId: z.string().min(1).optional(),
  manualGradingStatus: z.enum(["pending", "graded", "not_required"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

export const agsPublishAttemptQuerySchema = z.object({
  status: z.enum(["pending", "published", "failed", "retry_exhausted", "not_applicable", "skipped_duplicate"]).optional(),
  cohortId: z.string().min(1).optional(),
  contentId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

export const agsPublishAttemptExportQuerySchema = agsPublishAttemptQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(10000).default(10000)
});

export const notificationDiagnosticQuerySchema = z.object({
  status: z.enum(["pending", "delivered", "dead_letter"]).default("dead_letter"),
  event: z.enum(["ags.retry_exhausted"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

export const auditEventQuerySchema = z.object({
  action: z.enum(["squad.assignment.changed", "question.manual_grade.upserted", "ags.queue.process_due.triggered"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export const schedulerAgsProcessDueSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(25)
});

export const agsPublishRetrySchema = z.object({
  agsAccessToken: z.string().min(1).optional()
});
