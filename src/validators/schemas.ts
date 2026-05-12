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
  squadId: z.string().uuid()
});

export const contentCreateSchema = z.object({
  id: z.string().optional(),
  courseId: z.string().min(1),
  cohortId: z.string().min(1).optional(),
  role: z.enum(["admin", "instructor", "learner", "all"]).default("all"),
  type: z.enum(["module", "challenge", "game"]),
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(4000),
  maxScore: z.number().nonnegative(),
  lineItemUrl: z.string().url().optional(),
  status: z.enum(["draft", "published", "archived"]).default("draft")
});

export const scoreSubmitSchema = z.object({
  contentId: z.string().min(1),
  score: z.number().nonnegative(),
  maxScore: z.number().positive().optional(),
  progressPercent: z.number().min(0).max(100).default(100),
  agsAccessToken: z.string().optional()
});
