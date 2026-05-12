export type PactRole = "admin" | "instructor" | "learner";
export type ContentType = "module" | "challenge" | "game";
export type ContentStatus = "draft" | "published" | "archived";

export type PactUser = {
  id: string;
  lmsUserId: string;
  email?: string;
  name?: string;
  role: PactRole;
  courseId: string;
  cohortId: string;
  squadId?: string;
  createdAt: string;
  updatedAt: string;
};

export type Squad = {
  id: string;
  courseId: string;
  cohortId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type PactContent = {
  id: string;
  courseId: string;
  cohortId?: string;
  role: PactRole | "all";
  type: ContentType;
  title: string;
  prompt: string;
  maxScore: number;
  lineItemUrl?: string;
  status: ContentStatus;
  createdAt: string;
  updatedAt: string;
};

export type PactScore = {
  id: string;
  courseId: string;
  cohortId: string;
  squadId?: string;
  userId: string;
  contentId: string;
  contentType: ContentType;
  score: number;
  maxScore: number;
  progressPercent: number;
  agsStatus: "pending" | "published" | "failed" | "not_applicable";
  createdAt: string;
  updatedAt: string;
};
