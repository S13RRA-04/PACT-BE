import { AppError } from "../errors/AppError.js";
import { LmsAgsClient } from "../integrations/lmsAgsClient.js";
import { PactRepository } from "../repositories/pactRepository.js";
import type { PactSession } from "../auth/sessionService.js";
import type { PactAnswerValue, PactContent, PactUser } from "../domain/types.js";

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
      contentType: session.contentType
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
