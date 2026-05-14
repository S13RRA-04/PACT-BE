import { AppError } from "../errors/AppError.js";
import { LmsAgsClient } from "../integrations/lmsAgsClient.js";
import { PactRepository } from "../repositories/pactRepository.js";
import type { PactSession } from "../auth/sessionService.js";

export class PactService {
  constructor(private readonly repository: PactRepository, private readonly ags: LmsAgsClient) {}

  async getContent(session: PactSession) {
    const user = await this.repository.requireUser(session.userId);
    return this.repository.listContentFor(user);
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
      squadNumber: squad?.number ?? squad?.name.match(/^Squad ([1-4])$/)?.[1]
    };
  }

  async getSessionDiagnostic(session: PactSession) {
    const user = await this.repository.requireUser(session.userId);
    const visibleContent = await this.repository.listContentFor(user);

    return {
      courseId: session.courseId,
      cohortId: session.cohortId,
      role: session.role,
      visibleContentCount: visibleContent.length
    };
  }

  async submitScore(session: PactSession, input: { contentId: string; score: number; maxScore?: number; progressPercent: number; agsAccessToken?: string }) {
    const user = await this.repository.requireUser(session.userId);
    const content = await this.repository.requireContent(input.contentId);

    if (content.courseId !== user.courseId || (content.cohortId && content.cohortId !== user.cohortId)) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this user");
    }

    if (content.status !== "published") {
      throw new AppError(403, "CONTENT_NOT_AVAILABLE", "Content is not available");
    }

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

    return this.repository.upsertScore({
      user,
      contentId: content.id,
      contentType: content.type,
      score: input.score,
      maxScore: input.maxScore ?? content.maxScore,
      progressPercent: input.progressPercent,
      agsStatus
    });
  }

  async getScoreboard(session: PactSession) {
    return this.repository.scoreboard(session.courseId, session.cohortId, session.squadId);
  }
}
