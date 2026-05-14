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
  lmsLabel?: string;
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

export type PactAgsContext = {
  id: string;
  courseId: string;
  cohortId: string;
  userId: string;
  lineItemsUrl?: string;
  lineItemUrl?: string;
  scopes: string[];
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
    optional?: boolean;
    maxAttempts?: number;
    gradingMode?: "automatic" | "manual";
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
  agsStatus: "not_ready" | "pending" | "published" | "failed" | "not_applicable";
  createdAt: string;
  updatedAt: string;
};

export type PactAgsPublishAttempt = {
  id: string;
  courseId: string;
  cohortId: string;
  squadId?: string;
  userId: string;
  contentId: string;
  lineItemUrl?: string;
  score: number;
  maxScore: number;
  progressPercent: number;
  status: "pending" | "published" | "failed" | "retry_exhausted" | "not_applicable" | "skipped_duplicate";
  retryCount?: number;
  nextRetryAt?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt?: string;
};

export type PactAssignmentCompletion = {
  complete: boolean;
  status: "in_progress" | "pending_manual" | "failed_must_pass" | "complete";
  requiredQuestionIds: string[];
  answeredRequiredQuestionIds: string[];
  pendingQuestionIds: string[];
  pendingManualQuestionIds: string[];
  failedMustPassQuestionIds: string[];
  exhaustedQuestionIds: string[];
  score: number;
  maxScore: number;
};

export type PactNotification = {
  id: string;
  event: "ags.retry_exhausted";
  sinkUrl: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "dead_letter";
  attemptCount: number;
  nextAttemptAt: string;
  lastStatus?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type PactAnswerValue = string | string[] | Record<string, string> | boolean;

export type PactContentProgress = {
  id: string;
  courseId: string;
  cohortId: string;
  squadId?: string;
  userId: string;
  contentId: string;
  contentType: ContentType;
  answers: Record<string, PactAnswerValue>;
  answeredQuestionIds: string[];
  progressPercent: number;
  score?: number;
  maxScore?: number;
  status: "not_started" | "in_progress" | "submitted";
  submittedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PactQuestionAttempt = {
  id: string;
  courseId: string;
  cohortId: string;
  squadId?: string;
  userId: string;
  contentId: string;
  contentType: ContentType;
  questionId: string;
  questionVersion?: number;
  attemptNumber: number;
  answer: PactAnswerValue;
  score: number;
  maxScore: number;
  isCorrect: boolean;
  feedbackExposed: boolean;
  feedbackExposedAt?: string;
  submittedAt: string;
  createdAt: string;
};

export type PactQuestionGrade = {
  id: string;
  courseId: string;
  cohortId: string;
  squadId?: string;
  userId: string;
  contentId: string;
  questionId: string;
  attemptId: string;
  score: number;
  maxScore: number;
  isCorrect: boolean;
  feedback?: string;
  gradedByUserId: string;
  gradedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type PactAuditEvent = {
  id: string;
  action: "squad.assignment.changed" | "question.manual_grade.upserted" | "ags.queue.process_due.triggered";
  actorUserId: string;
  targetUserId: string;
  courseId: string;
  cohortId: string;
  metadata: {
    previousSquadId?: string;
    nextSquadId?: string;
    nextSquadNumber?: SquadNumber;
    contentId?: string;
    questionId?: string;
    attemptId?: string;
    previousScore?: number;
    nextScore?: number;
    maxScore?: number;
    previousIsCorrect?: boolean;
    nextIsCorrect?: boolean;
    feedbackChanged?: boolean;
    scanned?: number;
    retried?: number;
    failed?: number;
    exhausted?: number;
    limit?: number;
  };
  createdAt: string;
};
