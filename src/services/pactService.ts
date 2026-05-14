import { AppError } from "../errors/AppError.js";
import { LmsAgsClient } from "../integrations/lmsAgsClient.js";
import { PactRepository } from "../repositories/pactRepository.js";
import type { PactSession } from "../auth/sessionService.js";
import type { PactAnswerValue, PactContent, PactQuestion, PactUser } from "../domain/types.js";

export class PactService {
  constructor(private readonly repository: PactRepository, private readonly ags: LmsAgsClient) {}

  async getContent(session: PactSession) {
    const user = await this.repository.requireUser(session.userId);
    return this.repository.listContentFor(user, session.contentType);
  }

  async getContentProgress(session: PactSession) {
    const user = await this.repository.requireUser(session.userId);
    const content = await this.repository.listContentFor(user, session.contentType);
    return this.repository.listProgressForUser(user, content.map((item) => item.id));
  }

  async getSession(session: PactSession) {
    const user = await this.repository.requireUser(session.userId);
    const squad = user.squadId ? await this.repository.getSquad(user.squadId) : undefined;
    return {
      userId: user.id,
      role: user.role,
      courseId: user.courseId,
      cohortId: user.cohortId,
      squadId: user.squadId,
      squadNumber: squad?.number ?? squad?.name.match(/^Squad ([1-4])$/)?.[1],
      contentType: session.contentType,
      csrfToken: session.csrfToken
    };
  }

  async getSessionDiagnostic(session: PactSession) {
    const user = await this.repository.requireUser(session.userId);
    const visibleContent = await this.repository.listContentFor(user);
    const [contentCounts, publishedModuleCount] = await Promise.all([
      this.repository.listContentCountsForDiagnostics(session),
      this.repository.countPublishedModulesForCourse(session.courseId)
    ]);
    const hasPublishedModules = publishedModuleCount > 0;

    return {
      courseId: session.courseId,
      cohortId: session.cohortId,
      role: session.role,
      contentType: session.contentType,
      visibleContentCount: visibleContent.length,
      contentCounts,
      publishedModuleWarning: hasPublishedModules ? undefined : {
        code: "NO_PUBLISHED_MODULES",
        message: `No published modules exist for course ${session.courseId}. Learner module launches will not show module content until modules are imported and published.`
      }
    };
  }

  async getCohortProgressAnalytics(session: PactSession, cohortId?: string) {
    if (session.role !== "admin" && session.role !== "instructor") {
      throw new AppError(403, "FORBIDDEN", "Instructor access is required");
    }
    return this.repository.cohortProgressAnalytics(session, cohortId);
  }

  async getQuestionAttempts(session: PactSession, input: {
    cohortId?: string;
    contentId?: string;
    userId?: string;
    questionId?: string;
    limit: number;
  }) {
    if (session.role !== "admin" && session.role !== "instructor") {
      throw new AppError(403, "FORBIDDEN", "Instructor access is required");
    }
    return this.repository.listQuestionAttemptsForCohort({ session, ...input });
  }

  async submitScore(session: PactSession, input: { contentId: string; score: number; maxScore?: number; progressPercent: number; agsAccessToken?: string }) {
    const user = await this.repository.requireUser(session.userId);
    const content = await this.repository.requireContent(input.contentId);
    this.requireLearnerContentAccess(user, content);

    if (input.score > (input.maxScore ?? content.maxScore)) {
      throw new AppError(400, "INVALID_SCORE", "Score cannot exceed max score");
    }

    const agsStatus = await this.ags.publishScore({
      lineItemUrl: content.lineItemUrl,
      accessToken: input.agsAccessToken,
      userId: user.lmsUserId,
      score: input.score,
      maxScore: input.maxScore ?? content.maxScore,
      activityProgress: input.progressPercent >= 100 ? "Completed" : "InProgress",
      gradingProgress: "FullyGraded"
    });

    const score = await this.repository.upsertScore({
      user,
      contentId: content.id,
      contentType: content.type,
      score: input.score,
      maxScore: input.maxScore ?? content.maxScore,
      progressPercent: input.progressPercent,
      agsStatus
    });
    await this.repository.upsertContentProgress({
      user,
      content,
      progressPercent: input.progressPercent,
      status: "submitted",
      score: input.score,
      maxScore: input.maxScore ?? content.maxScore
    });
    return score;
  }

  async updateContentProgress(session: PactSession, contentId: string, input: {
    answers?: Record<string, PactAnswerValue>;
    progressPercent?: number;
    status?: "not_started" | "in_progress" | "submitted";
  }) {
    const user = await this.repository.requireUser(session.userId);
    const content = await this.repository.requireContent(contentId);
    this.requireLearnerContentAccess(user, content);
    const answers = input.answers ? filterAnswersForContent(content, input.answers) : undefined;
    return this.repository.upsertContentProgress({
      user,
      content,
      answers,
      progressPercent: input.progressPercent,
      status: input.status
    });
  }

  async submitQuestionAttempt(session: PactSession, contentId: string, questionId: string, input: {
    answer: PactAnswerValue;
    feedbackExposed: boolean;
  }) {
    const user = await this.repository.requireUser(session.userId);
    const content = await this.repository.requireContent(contentId);
    this.requireLearnerContentAccess(user, content);
    const question = content.questions?.find((item) => item.id === questionId);
    if (!question) throw new AppError(404, "QUESTION_NOT_FOUND", "PACT question was not found for this content");

    const score = scoreQuestion(question, input.answer);
    const maxScore = question.scoring.points;
    const attempt = await this.repository.recordQuestionAttempt({
      user,
      content,
      questionId,
      questionVersion: question.version,
      answer: input.answer,
      score,
      maxScore,
      isCorrect: score >= maxScore,
      feedbackExposed: input.feedbackExposed
    });
    const existingProgress = (await this.repository.listProgressForUser(user, [content.id]))[0];
    const answers = { ...(existingProgress?.answers ?? {}), [questionId]: input.answer };
    const progress = await this.repository.upsertContentProgress({
      user,
      content,
      answers
    });

    return { attempt, progress };
  }

  async getScoreboard(session: PactSession) {
    const user = await this.repository.requireUser(session.userId);
    return this.repository.scoreboard(user.courseId, user.cohortId, user.squadId);
  }

  private requireLearnerContentAccess(user: PactUser, content: PactContent) {
    if (content.courseId !== user.courseId || (content.cohortId && content.cohortId !== user.cohortId)) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this user");
    }

    if (user.role === "learner" && content.role !== "all" && content.role !== user.role) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this user");
    }

    if (user.role === "learner" && content.status !== "published") {
      throw new AppError(403, "CONTENT_NOT_AVAILABLE", "Content is not available");
    }
  }
}

function filterAnswersForContent(content: PactContent, answers: Record<string, PactAnswerValue>) {
  const questionIds = new Set((content.questions ?? []).map((question) => question.id));
  if (!questionIds.size) return answers;
  return Object.fromEntries(Object.entries(answers).filter(([questionId]) => questionIds.has(questionId)));
}

function scoreQuestion(question: PactQuestion, value: PactAnswerValue) {
  const payload = question.payload;
  const points = question.scoring.points;
  if (payload.kind === "true_false") return value === payload.correct ? points : 0;
  if (payload.kind === "multiple_choice") {
    const correct = Array.isArray(payload.correct) ? payload.correct.filter((item): item is string => typeof item === "string") : [];
    const selected = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    return sameSet(correct, selected) ? points : 0;
  }
  if (payload.kind === "fill_blank" && isRecord(value)) {
    const blanks = Array.isArray(payload.blanks) ? payload.blanks : [];
    const correct = blanks.filter((blank) => {
      if (!isQuestionBlank(blank)) return false;
      const answer = value[blank.id] ?? "";
      return blank.accepted.some((accepted) => blank.caseSensitive ? accepted === answer : accepted.toLowerCase() === answer.trim().toLowerCase());
    }).length;
    return blanks.length ? Math.round((correct / blanks.length) * points) : 0;
  }
  if (payload.kind === "drag_match" && isRecord(value)) {
    const matches = Array.isArray(payload.matches) ? payload.matches : [];
    const correct = matches.filter((match) => isQuestionMatch(match) && value[match.sourceId] === match.targetId).length;
    return matches.length ? Math.round((correct / matches.length) * points) : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQuestionBlank(value: unknown): value is { id: string; accepted: string[]; caseSensitive?: boolean } {
  return isRecordLike(value)
    && typeof value.id === "string"
    && Array.isArray(value.accepted)
    && value.accepted.every((item) => typeof item === "string");
}

function isQuestionMatch(value: unknown): value is { sourceId: string; targetId: string } {
  return isRecordLike(value) && typeof value.sourceId === "string" && typeof value.targetId === "string";
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((value) => right.includes(value));
}
