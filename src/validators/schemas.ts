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
