export type PactRole = "admin" | "instructor" | "learner";
export type ContentType = "module" | "challenge" | "game" | "assessment";
export type ContentStatus = "draft" | "published" | "archived";
export type SquadNumber = "1" | "2" | "3" | "4";

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
  number?: SquadNumber;
  createdAt: string;
  updatedAt: string;
};

export type PactContent = {
  id: string;
  courseId: string;
  cohortId?: string | null;
  role: PactRole | "all";
  type: ContentType;
  title: string;
  prompt: string;
  maxScore: number;
  lineItemUrl?: string;
  day?: string;
  questionCount?: number;
  questions?: PactQuestion[];
  status: ContentStatus;
  createdAt: string;
  updatedAt: string;
};

export type PactQuestion = {
  id: string;
  version: number;
  supersedes: string | null;
  type: string;
  day: string;
  role: string;
  topic: string;
  tags: string[];
  stem: Record<string, string>;
  payload: Record<string, unknown>;
  feedback: Record<string, unknown>;
  scoring: {
    points: number;
    difficulty: string;
    mustPass: boolean;
  };
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

export type PactAuditEvent = {
  id: string;
  action: "squad.assignment.changed";
  actorUserId: string;
  targetUserId: string;
  courseId: string;
  cohortId: string;
  metadata: {
    previousSquadId?: string;
    nextSquadId: string;
    nextSquadNumber?: SquadNumber;
  };
  createdAt: string;
};
