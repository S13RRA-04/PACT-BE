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

const challengeMechanicsSchema = z.object({
  kind: z.literal("challenge_path"),
  title: z.string().min(1).max(160),
  prompt: z.string().min(1).max(1200),
  resultLabel: z.string().min(1).max(80).optional(),
  releases: z.array(z.object({
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(1200),
    releaseLabel: z.string().min(1).max(80).optional(),
    unlocked: z.boolean().default(false),
    files: z.array(z.object({
      key: z.string().min(1).max(500),
      title: z.string().min(1).max(160).optional(),
      description: z.string().min(1).max(800).optional(),
      contentType: z.string().min(1).max(120).optional()
    })).max(24).default([]),
    questionIds: z.array(z.string().min(1).max(120)).max(100).optional()
  })).max(12).optional(),
  caseFiles: z.array(z.object({
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(1200),
    releaseLabel: z.string().min(1).max(80).optional(),
    classification: z.string().min(1).max(80).optional()
  })).max(12).optional(),
  evidenceArtifacts: z.array(z.object({
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    source: z.string().min(1).max(160),
    detail: z.string().min(1).max(1200),
    releasedAt: z.string().min(1).max(80).optional(),
    tags: z.array(z.string().min(1).max(40)).max(8).optional()
  })).max(24).optional(),
  synthesisPrompts: z.array(z.object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    prompt: z.string().min(1).max(800),
    required: z.boolean().optional()
  })).max(8).optional(),
  defaultPathId: z.string().min(1).max(80).optional(),
  paths: z.array(z.object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    detail: z.string().min(1).max(400),
    score: z.number().min(0).max(100)
  })).min(1).max(6)
});

const gameMechanicsSchema = z.object({
  kind: z.literal("packet_capture"),
  title: z.string().min(1).max(160),
  prompt: z.string().min(1).max(1200),
  resultLabel: z.string().min(1).max(80).optional(),
  maxScore: z.number().positive().max(100000).optional(),
  initiallyCaptured: z.array(z.string().min(1).max(80)).max(24).optional(),
  nodes: z.array(z.object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    points: z.number().min(0).max(100000)
  })).min(1).max(24)
});

const assessmentMechanicsSchema = z.object({
  kind: z.literal("readiness_checklist"),
  title: z.string().min(1).max(160),
  prompt: z.string().min(1).max(1200),
  resultLabel: z.string().min(1).max(80).optional(),
  timing: z.object({
    enabled: z.boolean().default(true),
    timeLimitSeconds: z.number().int().positive().max(86400).optional(),
    startTrigger: z.literal("learner_start").default("learner_start"),
    submitTrigger: z.literal("content_submit").default("content_submit")
  }).optional(),
  checks: z.array(z.object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(160),
    initiallyChecked: z.boolean().optional()
  })).min(1).max(12)
});

const capstoneMechanicsSchema = z.object({
  kind: z.literal("daily_progression_capstone"),
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(4000),
  day: z.number().int().min(1).max(30),
  session: z.string().min(1).max(80),
  version: z.number().int().min(1),
  releaseDependencies: z.array(z.string().min(1).max(80)).max(20),
  estimatedMinutes: z.number().int().positive().max(480),
  scoringMode: z.string().min(1).max(80),
  progressionRole: z.string().min(1).max(80),
  questions: z.array(z.record(z.unknown())).max(30),
  rubric: z.object({
    maxPoints: z.number().nonnegative(),
    categories: z.array(z.object({
      categoryId: z.string().min(1).max(80),
      label: z.object({ en: z.string().min(1) }),
      maxPoints: z.number().nonnegative()
    })).max(20)
  })
});

const contentMechanicsSchema = z.discriminatedUnion("kind", [
  challengeMechanicsSchema,
  gameMechanicsSchema,
  assessmentMechanicsSchema,
  capstoneMechanicsSchema
]);

export const contentCreateSchema = z.object({
  id: z.string().optional(),
  courseId: z.string().min(1),
  cohortId: z.string().min(1).optional(),
  role: z.enum(["admin", "instructor", "learner", "all"]).default("all"),
  type: z.enum(["module", "challenge", "workshop", "game", "assessment", "capstone"]),
  title: z.string().min(1).max(200),
  lmsLabel: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(4000),
  maxScore: z.number().nonnegative(),
  lineItemUrl: z.string().url().optional(),
  mechanics: contentMechanicsSchema.optional(),
  status: z.enum(["draft", "published", "archived"]).default("draft"),
  locked: z.boolean().default(true)
}).superRefine((content, ctx) => {
  if (!content.mechanics) return;
  const mechanics = content.mechanics;
  const expectedKind = expectedMechanicsKind(content.type);
  if (expectedKind && mechanics.kind !== expectedKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${content.type} content must use ${expectedKind} mechanics`,
      path: ["mechanics", "kind"]
    });
  }
  if (content.type === "module" || content.type === "workshop") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${content.type} content does not support mechanics`,
      path: ["mechanics"]
    });
  }
  if (content.type !== "capstone" && mechanics.kind === "daily_progression_capstone") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "daily_progression_capstone mechanics are only valid for capstone content",
      path: ["mechanics", "kind"]
    });
  }
  if (mechanics.kind === "challenge_path" && mechanics.defaultPathId && !mechanics.paths.some((path) => path.id === mechanics.defaultPathId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "defaultPathId must match one of the challenge paths",
      path: ["mechanics", "defaultPathId"]
    });
  }
  if (mechanics.kind === "packet_capture" && (mechanics.initiallyCaptured ?? []).some((id) => !mechanics.nodes.some((node) => node.id === id))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "initiallyCaptured ids must match game nodes",
      path: ["mechanics", "initiallyCaptured"]
    });
  }
});

function expectedMechanicsKind(type: "module" | "challenge" | "workshop" | "game" | "assessment" | "capstone") {
  if (type === "challenge") return "challenge_path";
  if (type === "game") return "packet_capture";
  if (type === "assessment") return "readiness_checklist";
  if (type === "capstone") return "daily_progression_capstone";
  return undefined;
}

export const contentStatusUpdateSchema = z.object({
  status: z.enum(["draft", "published", "archived"])
});

export const contentLockUpdateSchema = z.object({
  locked: z.boolean()
});

export const deckLockUpdateSchema = z.object({
  unlocked: z.boolean()
});

export const contentAssignmentUpdateSchema = z.object({
  cohortId: z.string().min(1).nullable()
});

export const contentLmsLabelUpdateSchema = z.object({
  lmsLabel: z.string().min(1).max(200).nullable()
});

export const contentMechanicsUpdateSchema = z.object({
  mechanics: contentMechanicsSchema.nullable()
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
  mechanicsState: z.record(z.unknown()).optional(),
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

export const agsBackfillSchema = z.object({
  cohortId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500)
});

export const bugReportCreateSchema = z.object({
  title: z.string().trim().min(4).max(160),
  description: z.string().trim().min(10).max(5000),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  pageUrl: z.string().url().max(2048).optional(),
  userAgent: z.string().trim().max(512).optional()
});

export const releaseImportSchema = z.object({
  prefix: z.string().trim().min(1).max(1000)
});

export const deckImportSchema = z.object({
  prefix: z.string().trim().min(1).max(1000)
});

const localizedStringSchema = z.object({ en: z.string().min(1) });

export const capstoneImportSchema = z.object({
  cohortId: z.string().min(1).optional(),
  capstone: z.object({
    _id: z.string().min(1).max(120),
    courseId: z.string().min(1).max(80),
    caseId: z.string().min(1).max(80),
    day: z.number().int().min(1).max(30),
    session: z.literal("end_of_day"),
    version: z.number().int().min(1),
    title: localizedStringSchema,
    studentInstructions: localizedStringSchema,
    instructorNotes: localizedStringSchema.optional(),
    releaseDependencies: z.array(z.string().min(1).max(80)).max(20),
    estimatedMinutes: z.number().int().positive().max(480),
    scoringMode: z.string().min(1).max(80),
    progressionRole: z.string().min(1).max(80),
    questions: z.array(z.record(z.unknown())).max(30),
    rubric: z.object({
      maxPoints: z.number().nonnegative(),
      categories: z.array(z.object({
        categoryId: z.string().min(1).max(80),
        label: localizedStringSchema,
        maxPoints: z.number().nonnegative()
      })).max(20)
    })
  })
});

export const agendaUploadSchema = z.object({
  cohortId: z.string().trim().min(1).max(160).optional(),
  fileName: z.string().trim().min(1).max(240),
  contentType: z.string().trim().min(1).max(160).optional(),
  bodyBase64: z.string().trim().min(1)
});
