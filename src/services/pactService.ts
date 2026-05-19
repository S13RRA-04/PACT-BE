import { AppError, isAppError } from "../errors/AppError.js";
import { LmsAgsClient } from "../integrations/lmsAgsClient.js";
import { LmsTokenClient } from "../integrations/lmsTokenClient.js";
import { PactRepository } from "../repositories/pactRepository.js";
import { presignR2GetObject } from "./r2Service.js";
import { assertQuestionAttemptAllowed, evaluateAssignmentCompletion, isManualQuestion, type EffectiveQuestionAttempt } from "./assignmentCompletionPolicy.js";
import { scheduleAgsRetry } from "./agsRetryQueue.js";
import type { PactSession } from "../auth/sessionService.js";
import type { AppConfig } from "../config/config.js";
import type { PactAgsPublishAttempt, PactAnswerValue, PactContent, PactContentProgress, PactMechanicsState, PactQuestion, PactUser } from "../domain/types.js";

type AgsBackfillSkipReasons = {
  alreadyPublished: number;
  alreadyPending: number;
  courseOrCohortMismatch: number;
  missingScore: number;
  notApplicable: number;
  duplicateCandidate: number;
};

type AgsBackfillResult = {
  scanned: number;
  queued: number;
  published: number;
  skipped: number;
  failed: number;
  skipReasons: AgsBackfillSkipReasons;
};

export class PactService {
  constructor(
    private readonly repository: PactRepository,
    private readonly ags: LmsAgsClient,
    private readonly tokens: LmsTokenClient,
    private readonly config: AppConfig
  ) {}

  async getContent(session: PactSession) {
    const user = await this.repository.requireUser(session.userId);
    const content = await this.repository.listContentFor(user, session.contentType, session.contentId);
    return content.map((item) => this.prepareContentForUser(user, item));
  }

  async getContentProgress(session: PactSession) {
    const user = await this.repository.requireUser(session.userId);
    const content = await this.repository.listContentFor(user, session.contentType, session.contentId);
    return this.repository.listProgressForUser(user, content.map((item) => item.id));
  }

  async getSquadContentProgress(session: PactSession) {
    const user = await this.repository.requireUser(session.userId);
    if (!user.squadId) {
      throw new AppError(409, "SQUAD_REQUIRED", "A squad assignment is required for squad progress");
    }
    const content = await this.repository.listContentFor(user, session.contentType, session.contentId);
    const squadContent = content.filter((item) => isSquadCompletionContent(item));
    const progress = await this.repository.listProgressForSquad(user, squadContent.map((item) => item.id));
    return Promise.all(progress.map((item) => {
      const itemContent = squadContent.find((contentItem) => contentItem.id === item.contentId);
      return itemContent ? this.hydrateSquadProgressFromAttempts(user, itemContent, item) : item;
    }));
  }

  async getSquadContentProgressForContent(session: PactSession, contentId: string) {
    const user = await this.repository.requireUser(session.userId);
    const content = this.prepareContentForUser(user, await this.repository.requireContent(contentId));
    this.requireSquadContentAccess(user, content);
    const progress = await this.repository.listProgressForSquad(user, [content.id]);
    return {
      contentId: content.id,
      squadId: user.squadId,
      progress: progress[0] ? await this.hydrateSquadProgressFromAttempts(user, content, progress[0]) : null
    };
  }

  async getContentCompletionStatus(session: PactSession, contentId: string) {
    const user = await this.repository.requireUser(session.userId);
    const content = this.prepareContentForUser(user, await this.repository.requireContent(contentId));
    this.requireLearnerContentAccess(user, content);
    if (isSquadCompletionContent(content) && user.squadId) {
      const [completion, squadProgressRecords, score] = await Promise.all([
        this.evaluateContentCompletion(user, content),
        this.repository.listProgressForSquad(user, [content.id]),
        this.repository.getScoreForUserContent(user.id, content.id)
      ]);
      return {
        contentId: content.id,
        completion,
        progress: squadProgressRecords[0] ? await this.hydrateSquadProgressFromAttempts(user, content, squadProgressRecords[0]) : undefined,
        score: score ? {
          score: score.score,
          maxScore: score.maxScore,
          progressPercent: score.progressPercent,
          agsStatus: score.agsStatus
        } : undefined
      };
    }
    const [completion, progressRecords, score] = await Promise.all([
      this.evaluateContentCompletion(user, content),
      this.repository.listProgressForUser(user, [content.id]),
      this.repository.getScoreForUserContent(user.id, content.id)
    ]);
    return {
      contentId: content.id,
      completion,
      progress: progressRecords[0],
      score: score ? {
        score: score.score,
        maxScore: score.maxScore,
        progressPercent: score.progressPercent,
        agsStatus: score.agsStatus
      } : undefined
    };
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
      contentId: session.contentId,
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

  async getAgsTokenContextDiagnostic(session: PactSession) {
    if (session.role !== "admin" && session.role !== "instructor") {
      throw new AppError(403, "FORBIDDEN", "Instructor access is required");
    }
    const context = await this.repository.getAgsContextForUser({
      userId: session.userId,
      courseId: session.courseId,
      cohortId: session.cohortId
    });
    return {
      courseId: session.courseId,
      cohortId: session.cohortId,
      hasLaunchContext: Boolean(context),
      hasScoreScope: Boolean(context?.scopes.includes(AGS_SCORE_SCOPE)),
      lineItemsUrl: context?.lineItemsUrl,
      lineItemUrl: context?.lineItemUrl,
      scopes: context?.scopes ?? [],
      updatedAt: context?.updatedAt
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
    manualGradingStatus?: "pending" | "graded" | "not_required";
    limit: number;
  }) {
    if (session.role !== "admin" && session.role !== "instructor") {
      throw new AppError(403, "FORBIDDEN", "Instructor access is required");
    }
    return this.repository.listQuestionAttemptsForCohort({ session, ...input });
  }

  async gradeManualQuestionAttempt(session: PactSession, attemptId: string, input: {
    score: number;
    feedback?: string;
  }) {
    if (session.role !== "admin" && session.role !== "instructor") {
      throw new AppError(403, "FORBIDDEN", "Instructor access is required");
    }

    const attempt = await this.repository.getQuestionAttemptForCourse(attemptId, session.courseId);
    if (!attempt) throw new AppError(404, "QUESTION_ATTEMPT_NOT_FOUND", "Question attempt was not found");

    const [user, content] = await Promise.all([
      this.repository.requireUser(attempt.userId),
      this.repository.requireContent(attempt.contentId)
    ]);
    if (content.courseId !== session.courseId || user.courseId !== session.courseId) {
      throw new AppError(403, "QUESTION_ATTEMPT_FORBIDDEN", "Question attempt is not assigned to this course");
    }

    const question = content.questions?.find((item) => item.id === attempt.questionId);
    if (!question) throw new AppError(404, "QUESTION_NOT_FOUND", "PACT question was not found for this content");
    if (!isManualQuestion(question)) {
      throw new AppError(400, "QUESTION_NOT_MANUAL", "Only manual grading questions can be graded by instructors");
    }
    if (input.score > attempt.maxScore) {
      throw new AppError(400, "INVALID_SCORE", "Score cannot exceed max score");
    }

    const grade = await this.repository.upsertQuestionGrade({
      attempt,
      score: input.score,
      maxScore: attempt.maxScore,
      isCorrect: isFullCreditManualGrade(input.score, attempt.maxScore),
      feedback: input.feedback,
      gradedByUserId: session.userId
    });
    const finalScore = await this.finalizeCompletedQuestionContent(user, content);
    return {
      grade,
      completion: finalScore?.completion,
      progress: finalScore?.progress,
      score: finalScore?.score
    };
  }

  async retryAgsPublishAttempt(session: PactSession, attemptId: string, input: { agsAccessToken?: string }) {
    if (session.role !== "admin" && session.role !== "instructor") {
      throw new AppError(403, "FORBIDDEN", "Instructor access is required");
    }

    const attempt = await this.repository.getAgsPublishAttemptForCourse(attemptId, session.courseId);
    if (!attempt) {
      throw new AppError(404, "AGS_ATTEMPT_NOT_FOUND", "AGS publish attempt was not found");
    }

    if (attempt.status !== "failed" && attempt.status !== "pending") {
      throw new AppError(409, "AGS_ATTEMPT_NOT_RETRYABLE", "Only failed or pending AGS publish attempts can be retried");
    }

    const [user, content] = await Promise.all([
      this.repository.requireUser(attempt.userId),
      this.repository.requireContent(attempt.contentId)
    ]);
    if (user.courseId !== session.courseId || content.courseId !== session.courseId) {
      throw new AppError(403, "AGS_ATTEMPT_FORBIDDEN", "AGS publish attempt is not assigned to this course");
    }

    const agsStatus = await this.publishQueuedAgsAttempt(attempt, input.agsAccessToken);

    const score = await this.repository.upsertScore({
      user,
      contentId: content.id,
      contentType: content.type,
      score: attempt.score,
      maxScore: attempt.maxScore,
      progressPercent: attempt.progressPercent,
      agsStatus
    });

    return { agsStatus, score };
  }

  async retryDueAgsPublishAttempts(limit = 25, scope?: { courseId?: string }) {
    const attempts = await this.repository.listDueAgsPublishAttempts({
      nowIso: new Date().toISOString(),
      limit,
      courseId: scope?.courseId
    });
    let retried = 0;
    let failed = 0;
    let exhausted = 0;
    for (const attempt of attempts) {
      const nextRetryCount = (attempt.retryCount ?? 0) + 1;
      try {
        const [user, content] = await Promise.all([
          this.repository.requireUser(attempt.userId),
          this.repository.requireContent(attempt.contentId)
        ]);
        await this.publishQueuedAgsAttempt(attempt);
        retried += 1;
      } catch {
        failed += 1;
        if (shouldMarkRetryExhausted(this.config, nextRetryCount)) exhausted += 1;
        // publishScoreToAgs records safe retry failure diagnostics.
      }
    }
    return { scanned: attempts.length, retried, failed, exhausted };
  }

  async processDueAgsPublishAttemptsForAdmin(session: PactSession, limit = 25) {
    if (session.role !== "admin" && session.role !== "instructor") {
      throw new AppError(403, "PACT_ROLE_FORBIDDEN", "Instructor access is required");
    }

    const result = await this.retryDueAgsPublishAttempts(limit, { courseId: session.courseId });
    await this.repository.recordManualAgsQueueProcessingAudit({ session, result, limit });
    return result;
  }

  async backfillCompletedAgsSubmissionsForAdmin(session: PactSession, input: { cohortId?: string; limit?: number } = {}) {
    if (session.role !== "admin" && session.role !== "instructor") {
      throw new AppError(403, "PACT_ROLE_FORBIDDEN", "Instructor access is required");
    }
    const limit = input.limit ?? 500;

    const progressRecords = await this.repository.listSubmittedUserProgressForAgsBackfill({
      courseId: session.courseId,
      cohortId: input.cohortId,
      limit
    });
    const notApplicableAttempts = await this.repository.listNotApplicableAgsAttemptsForBackfill({
      courseId: session.courseId,
      cohortId: input.cohortId,
      limit
    });
    const result = {
      scanned: 0,
      queued: 0,
      published: 0,
      skipped: 0,
      failed: 0,
      skipReasons: {
        alreadyPublished: 0,
        alreadyPending: 0,
        courseOrCohortMismatch: 0,
        missingScore: 0,
        notApplicable: 0,
        duplicateCandidate: 0
      }
    };
    const seen = new Set<string>();
    const operator = await this.repository.getUser(session.userId);

    for (const progress of progressRecords) {
      if (typeof progress.score !== "number" || typeof progress.maxScore !== "number") {
        this.recordAgsBackfillSkip(result, "missingScore");
        continue;
      }

      const key = agsBackfillKey({
        userId: progress.userId,
        contentId: progress.contentId,
        score: progress.score,
        maxScore: progress.maxScore,
        progressPercent: progress.progressPercent
      });
      seen.add(key);
      await this.backfillAgsCandidate(session, result, {
        userId: progress.userId,
        contentId: progress.contentId,
        cohortId: progress.cohortId,
        score: progress.score,
        maxScore: progress.maxScore,
        progressPercent: progress.progressPercent,
        comment: `Backfilled completed PACT submission from ${progress.submittedAt ?? progress.updatedAt}.`
      }, operator);
    }

    for (const attempt of notApplicableAttempts) {
      const key = agsBackfillKey(attempt);
      if (seen.has(key)) {
        result.scanned += 1;
        this.recordAgsBackfillSkip(result, "duplicateCandidate");
        continue;
      }
      seen.add(key);
      await this.backfillAgsCandidate(session, result, {
        userId: attempt.userId,
        contentId: attempt.contentId,
        cohortId: attempt.cohortId,
        score: attempt.score,
        maxScore: attempt.maxScore,
        progressPercent: attempt.progressPercent,
        comment: attempt.comment ?? `Retried previous not_applicable AGS outcome from ${attempt.createdAt}.`
      }, operator);
    }

    return result;
  }

  async submitScore(session: PactSession, input: { contentId: string; score: number; maxScore?: number; progressPercent: number; agsAccessToken?: string }) {
    const user = await this.repository.requireUser(session.userId);
    const content = this.prepareContentForUser(user, await this.repository.requireContent(input.contentId));
    this.requireLearnerContentAccess(user, content);

    if (input.score > (input.maxScore ?? content.maxScore)) {
      throw new AppError(400, "INVALID_SCORE", "Score cannot exceed max score");
    }

    const maxScore = input.maxScore ?? content.maxScore;
    const assignmentComplete = input.progressPercent >= 100;
    const [existingScore, existingProgress] = await Promise.all([
      this.repository.getScoreForUserContent(user.id, content.id),
      this.repository.listProgressForUser(user, [content.id]).then((items) => items[0])
    ]);
    this.assertAssessmentCanSubmit(content, existingProgress);
    const submittedAt = new Date().toISOString();
    const comment = buildAssessmentTimingComment(content, existingProgress, submittedAt);
    const scoreAlreadyPublished = assignmentComplete && isSamePublishedScore(existingScore, {
      score: input.score,
      maxScore,
      progressPercent: input.progressPercent
    });
    const agsStatus = !assignmentComplete
      ? "not_ready"
      : scoreAlreadyPublished && existingScore
        ? await this.recordSkippedDuplicateAgsAttempt(user, content, input, maxScore)
        : await this.publishScoreToAgs(user, content, { ...input, comment }, maxScore);

    const score = await this.repository.upsertScore({
      user,
      contentId: content.id,
      contentType: content.type,
      score: input.score,
      maxScore,
      progressPercent: input.progressPercent,
      agsStatus
    });
    await this.repository.upsertContentProgress({
      user,
      content,
      progressPercent: input.progressPercent,
      status: assignmentComplete ? "submitted" : "in_progress",
      submittedAt: assignmentComplete ? submittedAt : undefined,
      score: input.score,
      maxScore
    });
    return score;
  }

  async submitSquadScore(session: PactSession, contentId: string, input: { score: number; maxScore?: number; progressPercent: number }) {
    const user = await this.repository.requireUser(session.userId);
    const content = this.prepareContentForUser(user, await this.repository.requireContent(contentId));
    this.requireSquadContentAccess(user, content);

    if (input.score > (input.maxScore ?? content.maxScore)) {
      throw new AppError(400, "INVALID_SCORE", "Score cannot exceed max score");
    }

    const maxScore = input.maxScore ?? content.maxScore;
    const assignmentComplete = input.progressPercent >= 100;
    const submittedAt = new Date().toISOString();
    const progress = await this.repository.upsertSquadContentProgress({
      user,
      content,
      progressPercent: input.progressPercent,
      status: assignmentComplete ? "submitted" : "in_progress",
      submittedAt: assignmentComplete ? submittedAt : undefined,
      score: input.score,
      maxScore
    });

    if (assignmentComplete && user.squadId) {
      await this.propagateSquadScoreToMembers(user, content, { score: input.score, maxScore, progressPercent: input.progressPercent });
    }

    return {
      ...progress,
      agsStatus: "not_applicable" as const
    };
  }

  private async propagateSquadScoreToMembers(
    squadMember: PactUser,
    content: PactContent,
    input: { score: number; maxScore: number; progressPercent: number }
  ) {
    const members = await this.repository.listUsersForSquad(squadMember.squadId!, squadMember.courseId);
    await Promise.all(members.map(async (member) => {
      const existingScore = await this.repository.getScoreForUserContent(member.id, content.id);
      if (isSamePublishedScore(existingScore, input)) return;
      const agsStatus = await this.enqueueFinalAgsPublish(member, content, { score: input.score, progressPercent: input.progressPercent }, input.maxScore);
      await this.repository.upsertScore({
        user: member,
        contentId: content.id,
        contentType: content.type,
        score: input.score,
        maxScore: input.maxScore,
        progressPercent: input.progressPercent,
        agsStatus
      });
    }));
  }

  async updateContentProgress(session: PactSession, contentId: string, input: {
    answers?: Record<string, PactAnswerValue>;
    mechanicsState?: PactMechanicsState;
    progressPercent?: number;
    status?: "not_started" | "in_progress" | "submitted";
  }) {
    const user = await this.repository.requireUser(session.userId);
    const content = this.prepareContentForUser(user, await this.repository.requireContent(contentId));
    this.requireLearnerContentAccess(user, content);
    const existingProgress = (await this.repository.listProgressForUser(user, [content.id]))[0];
    if (content.type === "assessment" && existingProgress?.status === "submitted") {
      throw new AppError(409, "ASSESSMENT_ALREADY_SUBMITTED", "Assessment has already been submitted");
    }
    const answers = input.answers ? filterAnswersForContent(content, input.answers) : undefined;
    return this.repository.upsertContentProgress({
      user,
      content,
      answers,
      mechanicsState: input.mechanicsState,
      progressPercent: input.progressPercent,
      status: input.status
    });
  }

  async updateSquadContentProgress(session: PactSession, contentId: string, input: {
    answers?: Record<string, PactAnswerValue>;
    mechanicsState?: PactMechanicsState;
    progressPercent?: number;
    status?: "not_started" | "in_progress" | "submitted";
  }) {
    const user = await this.repository.requireUser(session.userId);
    const content = this.prepareContentForUser(user, await this.repository.requireContent(contentId));
    this.requireSquadContentAccess(user, content);
    const answers = input.answers ? filterAnswersForContent(content, input.answers) : undefined;
    return this.repository.upsertSquadContentProgress({
      user,
      content,
      answers,
      mechanicsState: input.mechanicsState,
      progressPercent: input.progressPercent,
      status: input.status
    });
  }

  async submitQuestionAttempt(session: PactSession, contentId: string, questionId: string, input: {
    answer: PactAnswerValue;
    feedbackExposed: boolean;
  }) {
    const user = await this.repository.requireUser(session.userId);
    const content = this.prepareContentForUser(user, await this.repository.requireContent(contentId));
    this.requireLearnerContentAccess(user, content);
    const isSquadContent = isSquadCompletionContent(content);
    const existingProgress = isSquadContent && user.squadId
      ? (await this.repository.listProgressForSquad(user, [content.id]))[0]
      : (await this.repository.listProgressForUser(user, [content.id]))[0];
    this.assertAssessmentCanSubmit(content, existingProgress);
    const question = content.questions?.find((item) => item.id === questionId);
    if (!question) throw new AppError(404, "QUESTION_NOT_FOUND", "PACT question was not found for this content");
    const existingAttemptCount = isSquadContent && user.squadId
      ? await this.repository.countQuestionAttemptsForSquadContentQuestion({ user, content, questionId })
      : await this.repository.countQuestionAttemptsForUserContentQuestion({ user, content, questionId });
    const attemptPolicy = assertQuestionAttemptAllowed(question, existingAttemptCount);
    if (!attemptPolicy.allowed) {
      throw new AppError(409, "QUESTION_ATTEMPT_LIMIT_REACHED", "Question attempt limit has been reached");
    }

    const score = isManualQuestion(question) ? 0 : scoreQuestion(question, input.answer);
    const maxScore = question.scoring.points;
    const attempt = await this.repository.recordQuestionAttempt({
      user,
      content,
      questionId,
      questionVersion: question.version,
      answer: input.answer,
      score,
      maxScore,
      isCorrect: !isManualQuestion(question) && score >= maxScore,
      feedbackExposed: input.feedbackExposed
    });
    const answers = { ...(existingProgress?.answers ?? {}), [questionId]: input.answer };
    const progress = isSquadContent && user.squadId
      ? await this.repository.upsertSquadContentProgress({ user, content, answers })
      : await this.repository.upsertContentProgress({ user, content, answers });

    const finalScore = await this.finalizeCompletedQuestionContent(user, content);
    return {
      attempt,
      feedback: buildSubmissionFeedback(question, score, maxScore, input.feedbackExposed, attemptPolicy.maxAttempts, attempt.attemptNumber),
      progress: finalScore?.progress ?? progress,
      score: finalScore?.score,
      completion: finalScore?.completion
    };
  }

  async getScoreboard(session: PactSession) {
    const user = await this.repository.requireUser(session.userId);
    return this.repository.scoreboard(user.courseId, user.cohortId);
  }

  async getGrades(session: PactSession, filters: { cohortId?: string } = {}) {
    const user = await this.repository.requireUser(session.userId);
    return this.repository.listGradeScores(user.courseId, filters.cohortId);
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

    if (user.role === "learner" && content.locked !== false) {
      throw new AppError(403, "CONTENT_LOCKED", "Content is locked by the instructor");
    }
  }

  private requireSquadContentAccess(user: PactUser, content: PactContent) {
    this.requireLearnerContentAccess(user, content);
    if (!isSquadCompletionContent(content)) {
      throw new AppError(400, "SQUAD_PROGRESS_UNSUPPORTED", "Squad progress is only supported for challenges, workshops, and capstones");
    }
    if (!user.squadId) {
      throw new AppError(409, "SQUAD_REQUIRED", "A squad assignment is required for squad progress");
    }
  }

  private prepareContentForUser(user: PactUser, content: PactContent): PactContent {
    const contentWithDeck = this.prepareDeckForUser(user, content);
    if (contentWithDeck.type !== "challenge" || contentWithDeck.mechanics?.kind !== "challenge_path") {
      return contentWithDeck;
    }

    const learnerView = user.role === "learner";
    const releases = (contentWithDeck.mechanics.releases ?? []).filter((release) => !learnerView || release.unlocked);
    const visibleReleaseIds = new Set(releases.map((release) => release.id));
    const visibleQuestionIds = new Set(releases.flatMap((release) => release.questionIds ?? []));
    const questions = (contentWithDeck.questions ?? []).filter((question) => {
      if (!question.releaseId) return true;
      return visibleReleaseIds.has(question.releaseId) || visibleQuestionIds.has(question.id);
    });

    return {
      ...contentWithDeck,
      questionCount: questions.length,
      questions,
      mechanics: {
        ...contentWithDeck.mechanics,
        releases: releases.map((release) => ({
          ...release,
          files: release.files.map((file) => ({
            ...file,
            ...this.challengeFileUrls(file.key)
          }))
        }))
      }
    };
  }

  private prepareDeckForUser(user: PactUser, content: PactContent): PactContent {
    if (!content.deck) return content;
    if (user.role === "learner" && !content.deck.unlocked) {
      return { ...content, deck: undefined };
    }
    const instructorGuideFiles = user.role === "learner"
      ? undefined
      : content.deck.instructorGuideFiles?.map((file) => ({
          ...file,
          ...this.fileUrls(file.key, "pact-instructor-guide")
        }));
    return {
      ...content,
      deck: {
        ...content.deck,
        files: content.deck.files.map((file) => ({
          ...file,
          ...this.fileUrls(file.key, "pact-slide-deck")
        })),
        instructorGuideFiles
      }
    };
  }

  private challengeFileUrls(key: string) {
    return this.fileUrls(key, "pact-release-file");
  }

  private fileUrls(key: string, fallbackName: string) {
    const r2Config = this.r2Config();
    if (!r2Config) return {};
    const fileName = key.split("/").pop() || fallbackName;
    return {
      viewUrl: presignR2GetObject(r2Config, key, { expiresIn: 3600 }),
      downloadUrl: presignR2GetObject(r2Config, key, {
        expiresIn: 3600,
        responseContentDisposition: `attachment; filename="${fileName.replace(/"/g, "")}"`
      })
    };
  }

  private r2Config() {
    const { r2AccountId, r2Endpoint, r2AccessKeyId, r2SecretAccessKey, r2BucketName } = this.config;
    if ((!r2AccountId && !r2Endpoint) || !r2AccessKeyId || !r2SecretAccessKey || !r2BucketName) return undefined;
    return {
      accountId: r2AccountId,
      endpoint: r2Endpoint,
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
      bucketName: r2BucketName
    };
  }

  private async publishScoreToAgs(
    user: PactUser,
    content: PactContent,
    input: { score: number; progressPercent: number; agsAccessToken?: string; comment?: string },
    maxScore: number,
    retryCount = 0,
    options: { lineItemUrl?: string; tokenUser?: PactUser } = {}
  ) {
    try {
      const agsStatus = await this.sendScoreToAgs(user, content, input, maxScore, options);
      await this.recordAgsAttempt(user, content, input, maxScore, agsStatus, undefined, retryCount, undefined, options.lineItemUrl);
      return agsStatus;
    } catch (error) {
      const nextRetryCount = retryCount;
      const canRetryAgain = shouldSchedulePersistentRetry(this.config, nextRetryCount);
      await this.recordAgsAttempt(user, content, input, maxScore, shouldMarkRetryExhausted(this.config, nextRetryCount) ? "retry_exhausted" : "failed", error, nextRetryCount, canRetryAgain
        ? new Date(Date.now() + retryDelayMs(this.config, nextRetryCount + 1)).toISOString()
        : undefined);
      if (input.agsAccessToken) {
        scheduleAgsRetry({
          config: this.config,
          repository: this.repository,
          ags: this.ags,
          user,
          content,
          score: input.score,
          maxScore,
          progressPercent: input.progressPercent,
          accessToken: input.agsAccessToken,
          comment: input.comment,
          retryCount: nextRetryCount
        });
      }
      throw error;
    }
  }

  private async backfillAgsCandidate(
    session: PactSession,
    result: AgsBackfillResult,
    candidate: {
      userId: string;
      contentId: string;
      cohortId: string;
      score: number;
      maxScore: number;
      progressPercent: number;
      comment: string;
    },
    operator?: PactUser | null
  ) {
    result.scanned += 1;
    try {
      const [user, content, existingPending, existingPublished] = await Promise.all([
        this.repository.requireUser(candidate.userId),
        this.repository.requireContent(candidate.contentId),
        this.repository.findAgsPublishAttempt({
          userId: candidate.userId,
          contentId: candidate.contentId,
          score: candidate.score,
          maxScore: candidate.maxScore,
          progressPercent: candidate.progressPercent,
          status: "pending"
        }),
        this.repository.findAgsPublishAttempt({
          userId: candidate.userId,
          contentId: candidate.contentId,
          score: candidate.score,
          maxScore: candidate.maxScore,
          progressPercent: candidate.progressPercent,
          status: "published"
        })
      ]);
      if (user.courseId !== session.courseId || content.courseId !== session.courseId || user.cohortId !== candidate.cohortId) {
        this.recordAgsBackfillSkip(result, "courseOrCohortMismatch");
        return;
      }
      if (existingPublished) {
        this.recordAgsBackfillSkip(result, "alreadyPublished");
        return;
      }
      if (existingPending) {
        this.recordAgsBackfillSkip(result, "alreadyPending");
        return;
      }

      const operatorLineItemUrl = operator ? await this.resolveLineItemUrl(operator, content) : undefined;
      const agsStatus = await this.enqueueFinalAgsPublish(user, content, {
        score: candidate.score,
        progressPercent: candidate.progressPercent,
        comment: candidate.comment
      }, candidate.maxScore, { lineItemUrl: operatorLineItemUrl, tokenUser: operator ?? undefined });
      await this.repository.upsertScore({
        user,
        contentId: content.id,
        contentType: content.type,
        score: candidate.score,
        maxScore: candidate.maxScore,
        progressPercent: candidate.progressPercent,
        agsStatus
      });
      if (agsStatus === "published") result.published += 1;
      else if (agsStatus === "pending") result.queued += 1;
      else this.recordAgsBackfillSkip(result, "notApplicable");
    } catch {
      result.failed += 1;
    }
  }

  private recordAgsBackfillSkip(result: AgsBackfillResult, reason: keyof AgsBackfillSkipReasons) {
    result.skipped += 1;
    result.skipReasons[reason] += 1;
  }

  private async finalizeCompletedQuestionContent(user: PactUser, content: PactContent) {
    const questions = content.questions ?? [];
    if (!questions.length) return undefined;

    const completion = await this.evaluateContentCompletion(user, content);
    if (!completion.complete) return { completion };

    const scoreValue = completion.score;
    const maxScore = completion.maxScore;
    const submittedAt = new Date().toISOString();
    const [existingScore, existingProgress] = await Promise.all([
      this.repository.getScoreForUserContent(user.id, content.id),
      this.repository.listProgressForUser(user, [content.id]).then((items) => items[0])
    ]);
    const input = {
      score: scoreValue,
      progressPercent: 100,
      comment: buildAssessmentTimingComment(content, existingProgress, submittedAt)
    };
    const agsStatus = isSamePublishedScore(existingScore, { ...input, maxScore })
      ? await this.recordSkippedDuplicateAgsAttempt(user, content, input, maxScore)
      : await this.enqueueFinalAgsPublish(user, content, input, maxScore);
    const [score, progress] = await Promise.all([
      this.repository.upsertScore({
        user,
        contentId: content.id,
        contentType: content.type,
        score: scoreValue,
        maxScore,
        progressPercent: 100,
        agsStatus
      }),
      this.repository.upsertContentProgress({
        user,
        content,
        progressPercent: 100,
        status: "submitted",
        submittedAt,
        score: scoreValue,
        maxScore
      })
    ]);
    return { score, progress, completion };
  }

  private async evaluateContentCompletion(user: PactUser, content: PactContent) {
    const questions = content.questions ?? [];
    if (!questions.length) {
      return {
        complete: false,
        status: "in_progress" as const,
        requiredQuestionIds: [],
        answeredRequiredQuestionIds: [],
        pendingQuestionIds: [],
        pendingManualQuestionIds: [],
        failedMustPassQuestionIds: [],
        exhaustedQuestionIds: [],
        score: 0,
        maxScore: 0
      };
    }
    const latestAttempts = await this.effectiveLatestQuestionAttempts(user, content);
    return evaluateAssignmentCompletion(questions, latestAttempts);
  }

  private async enqueueFinalAgsPublish(
    user: PactUser,
    content: PactContent,
    input: { score: number; progressPercent: number; comment?: string },
    maxScore: number,
    options: { lineItemUrl?: string; tokenUser?: PactUser } = {}
  ) {
    const lineItemUrl = await this.resolveLineItemUrl(user, content) ?? options.lineItemUrl;
    if (!lineItemUrl) {
      return this.publishScoreToAgs(user, content, input, maxScore);
    }

    if (await this.hasUsableAgsContext(user) || (options.tokenUser && await this.hasUsableAgsContext(options.tokenUser))) {
      return this.publishScoreToAgs(user, content, input, maxScore, 0, { ...options, lineItemUrl });
    }

    const existingPending = await this.repository.findAgsPublishAttempt({
      userId: user.id,
      contentId: content.id,
      score: input.score,
      maxScore,
      progressPercent: input.progressPercent,
      status: "pending"
    });
    if (existingPending) return "pending" as const;

    await this.recordAgsAttempt(user, content, input, maxScore, "pending", undefined, 0, new Date().toISOString(), lineItemUrl);
    return "pending" as const;
  }

  private async publishQueuedAgsAttempt(attempt: PactAgsPublishAttempt, agsAccessToken?: string) {
    const nextRetryCount = (attempt.retryCount ?? 0) + 1;
    const [user, content] = await Promise.all([
      this.repository.requireUser(attempt.userId),
      this.repository.requireContent(attempt.contentId)
    ]);
    if (user.courseId !== attempt.courseId || content.courseId !== attempt.courseId) {
      throw new AppError(403, "AGS_ATTEMPT_FORBIDDEN", "AGS publish attempt is not assigned to this course");
    }

    try {
      const agsStatus = await this.sendScoreToAgs(user, content, {
        score: attempt.score,
        progressPercent: attempt.progressPercent,
        agsAccessToken,
        comment: attempt.comment
      }, attempt.maxScore);
      await this.repository.updateAgsPublishAttemptOutcome({
        id: attempt.id,
        status: agsStatus,
        retryCount: nextRetryCount
      });
      await this.repository.upsertScore({
        user,
        contentId: content.id,
        contentType: content.type,
        score: attempt.score,
        maxScore: attempt.maxScore,
        progressPercent: attempt.progressPercent,
        agsStatus
      });
      return agsStatus;
    } catch (error) {
      const canRetryAgain = shouldSchedulePersistentRetry(this.config, nextRetryCount);
      const status = shouldMarkRetryExhausted(this.config, nextRetryCount) ? "retry_exhausted" : "failed";
      await this.repository.updateAgsPublishAttemptOutcome({
        id: attempt.id,
        status,
        retryCount: nextRetryCount,
        nextRetryAt: canRetryAgain
          ? new Date(Date.now() + retryDelayMs(this.config, nextRetryCount + 1)).toISOString()
          : undefined,
        errorCode: isAppError(error) ? error.code : undefined,
        errorMessage: isAppError(error) ? error.message : undefined
      });
      await this.repository.upsertScore({
        user,
        contentId: content.id,
        contentType: content.type,
        score: attempt.score,
        maxScore: attempt.maxScore,
        progressPercent: attempt.progressPercent,
        agsStatus: status === "retry_exhausted" ? "failed" : status
      });
      throw error;
    }
  }

  private async sendScoreToAgs(
    user: PactUser,
    content: PactContent,
    input: { score: number; progressPercent: number; agsAccessToken?: string; comment?: string },
    maxScore: number,
    options: { lineItemUrl?: string; tokenUser?: PactUser } = {}
  ) {
    const tokenUser = options.tokenUser ?? user;
    let accessToken = input.agsAccessToken;
    let lineItemUrl = options.lineItemUrl ?? await this.resolveLineItemUrl(user, content);
    if (!accessToken && (lineItemUrl || await this.hasWritableAgsContext(tokenUser))) {
      const scopes = lineItemUrl ? [AGS_SCORE_SCOPE] : [AGS_SCORE_SCOPE, AGS_LINE_ITEM_SCOPE];
      accessToken = await this.acquireAgsAccessToken(tokenUser, scopes);
    }
    if (!lineItemUrl && accessToken) {
      lineItemUrl = await this.resolveOrCreateLineItemUrl(tokenUser, content, maxScore, accessToken);
    }
    return this.ags.publishScore({
      lineItemUrl,
      accessToken,
      userId: user.lmsUserId,
      score: input.score,
      maxScore,
      activityProgress: input.progressPercent >= 100 ? "Completed" : "InProgress",
      gradingProgress: "FullyGraded",
      comment: input.comment
    });
  }

  private async effectiveLatestQuestionAttempts(user: PactUser, content: PactContent) {
    const latestAttempts = isSquadCompletionContent(content) && user.squadId
      ? await this.repository.listLatestQuestionAttemptsForSquadContent({ user, content })
      : await this.repository.listLatestQuestionAttemptsForUserContent({ user, content });
    const gradesByAttemptId = await this.repository.listQuestionGradesForAttempts([...latestAttempts.values()].map((attempt) => attempt.id));
    const effectiveAttempts = new Map<string, EffectiveQuestionAttempt>(latestAttempts);
    for (const [questionId, attempt] of latestAttempts.entries()) {
      const grade = gradesByAttemptId.get(attempt.id);
      if (grade) {
        effectiveAttempts.set(questionId, {
          ...attempt,
          score: grade.score,
          maxScore: grade.maxScore,
          isCorrect: grade.isCorrect,
          manualGraded: true
        });
      }
    }
    return effectiveAttempts;
  }

  private async hydrateSquadProgressFromAttempts(user: PactUser, content: PactContent, progress: PactContentProgress) {
    if (!isSquadCompletionContent(content) || !user.squadId) return progress;
    const latestAttempts = await this.repository.listLatestQuestionAttemptsForSquadContent({ user, content });
    if (!latestAttempts.size) return progress;

    const answersFromAttempts = Object.fromEntries(
      [...latestAttempts.entries()].map(([questionId, attempt]) => [questionId, attempt.answer])
    );
    const answers = { ...answersFromAttempts, ...(progress.answers ?? {}) };
    const answeredQuestionIds = Object.keys(answers).filter((questionId) => answers[questionId] !== undefined);
    return {
      ...progress,
      answers,
      answeredQuestionIds,
      progressPercent: Math.max(progress.progressPercent, deriveProgressPercent(answeredQuestionIds.length, content))
    };
  }

  private async acquireAgsAccessToken(user: PactUser, scopes = [AGS_SCORE_SCOPE]) {
    const context = await this.resolveAgsContext(user);
    if (!context) {
      throw new AppError(502, "AGS_CONTEXT_MISSING", "No AGS launch context is available for this course/cohort");
    }
    const missingScope = scopes.find((scope) => !context.scopes.includes(scope));
    if (missingScope) {
      throw new AppError(403, "AGS_SCOPE_MISSING", "LTI launch did not grant the required AGS scope");
    }
    const token = await this.tokens.getAgsAccessToken(scopes);
    return token.accessToken;
  }

  private async resolveLineItemUrl(user: PactUser, content: PactContent) {
    if (content.lineItemUrl) {
      return content.lineItemUrl;
    }
    const context = await this.resolveAgsContext(user);
    return context?.lineItemUrl;
  }

  private async hasUsableAgsContext(user: PactUser) {
    const context = await this.resolveAgsContext(user);
    return Boolean(context?.scopes.includes(AGS_SCORE_SCOPE));
  }

  private async hasWritableAgsContext(user: PactUser) {
    const context = await this.resolveAgsContext(user);
    return Boolean(context?.lineItemsUrl && context.scopes.includes(AGS_SCORE_SCOPE) && context.scopes.includes(AGS_LINE_ITEM_SCOPE));
  }

  private async resolveAgsContext(user: PactUser) {
    return await this.repository.getAgsContextForUser({
      userId: user.id,
      courseId: user.courseId,
      cohortId: user.cohortId
    }) ?? await this.repository.getLatestAgsContextForCourseCohort({
      courseId: user.courseId,
      cohortId: user.cohortId
    });
  }

  private async resolveOrCreateLineItemUrl(user: PactUser, content: PactContent, maxScore: number, accessToken: string) {
    const existingLineItemUrl = await this.resolveLineItemUrl(user, content);
    if (existingLineItemUrl) {
      return existingLineItemUrl;
    }

    const context = await this.resolveAgsContext(user);
    if (!context?.lineItemsUrl || !context.scopes.includes(AGS_LINE_ITEM_SCOPE)) {
      return undefined;
    }

    const lineItemUrl = await this.ags.findOrCreateLineItem({
      lineItemsUrl: context.lineItemsUrl,
      accessToken,
      label: content.lmsLabel ?? content.title,
      scoreMaximum: maxScore,
      resourceId: content.id,
      tag: content.type
    });
    await this.repository.updateContentLineItemUrl(content.id, lineItemUrl);
    content.lineItemUrl = lineItemUrl;
    return lineItemUrl;
  }

  private async recordSkippedDuplicateAgsAttempt(
    user: PactUser,
    content: PactContent,
    input: { score: number; progressPercent: number; comment?: string },
    maxScore: number
  ) {
    await this.recordAgsAttempt(user, content, input, maxScore, "skipped_duplicate");
    return "published" as const;
  }

  private async recordAgsAttempt(
    user: PactUser,
    content: PactContent,
    input: { score: number; progressPercent: number; comment?: string },
    maxScore: number,
    status: "pending" | "published" | "failed" | "retry_exhausted" | "not_applicable" | "skipped_duplicate",
    error?: unknown,
    retryCount?: number,
    nextRetryAt?: string,
    lineItemUrl?: string
  ) {
    return this.repository.recordAgsPublishAttempt({
      courseId: user.courseId,
      cohortId: user.cohortId,
      squadId: user.squadId,
      userId: user.id,
      contentId: content.id,
      lineItemUrl: lineItemUrl ?? await this.resolveLineItemUrl(user, content),
      score: input.score,
      maxScore,
      progressPercent: input.progressPercent,
      comment: input.comment,
      status,
      retryCount,
      nextRetryAt,
      errorCode: isAppError(error) ? error.code : undefined,
      errorMessage: isAppError(error) ? error.message : undefined
    });
  }

  private assertAssessmentCanSubmit(content: PactContent, progress: PactContentProgress | undefined) {
    if (content.type !== "assessment") return;
    if (progress?.status === "submitted") {
      throw new AppError(409, "ASSESSMENT_ALREADY_SUBMITTED", "Assessment has already been submitted");
    }
    if (!assessmentStartedAt(progress)) {
      throw new AppError(409, "ASSESSMENT_NOT_STARTED", "Assessment must be started before answers can be submitted");
    }
  }
}

function isFullCreditManualGrade(score: number, maxScore: number) {
  return score >= maxScore;
}

function isSquadCompletionContent(content: PactContent) {
  return content.type === "challenge" || content.type === "workshop" || content.type === "capstone";
}

function agsBackfillKey(input: { userId: string; contentId: string; score: number; maxScore: number; progressPercent: number }) {
  return `${input.userId}:${input.contentId}:${input.score}:${input.maxScore}:${input.progressPercent}`;
}

function filterAnswersForContent(content: PactContent, answers: Record<string, PactAnswerValue>) {
  const questionIds = new Set((content.questions ?? []).map((question) => question.id));
  if (!questionIds.size) return answers;
  return Object.fromEntries(Object.entries(answers).filter(([questionId]) => questionIds.has(questionId)));
}

function deriveProgressPercent(answeredCount: number, content: PactContent) {
  const questionCount = content.questionCount ?? content.questions?.length ?? 0;
  return questionCount ? Math.min(100, Math.round((answeredCount / questionCount) * 100)) : 0;
}

export function scoreQuestion(question: PactQuestion, value: PactAnswerValue) {
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
    if (!matches.length) return 0;
    if (payload.partialCredit === false) return correct === matches.length ? points : 0;
    return Math.round((correct / matches.length) * points);
  }
  return 0;
}

function buildSubmissionFeedback(question: PactQuestion, score: number, maxScore: number, feedbackExposed: boolean, maxAttempts: number | undefined, attemptNumber: number) {
  const status = isManualQuestion(question) ? "needs_review" : score >= maxScore ? "correct" : score > 0 ? "partial" : "incorrect";
  return {
    submissionId: question.id,
    status,
    earnedPoints: score,
    possiblePoints: maxScore,
    feedback: feedbackExposed ? selectFeedback(question.feedback, status) : undefined,
    nextState: {
      questionComplete: !isManualQuestion(question),
      attemptsRemaining: maxAttempts === undefined ? undefined : Math.max(0, maxAttempts - attemptNumber)
    }
  };
}

function selectFeedback(feedback: Record<string, unknown>, status: "correct" | "partial" | "incorrect" | "needs_review") {
  return feedback[status] ?? (status === "partial" ? feedback.incorrect : undefined);
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

function isSamePublishedScore(
  existing: { score: number; maxScore: number; progressPercent: number; agsStatus: string } | null,
  next: { score: number; maxScore: number; progressPercent: number }
) {
  return existing?.agsStatus === "published"
    && existing.score === next.score
    && existing.maxScore === next.maxScore
    && existing.progressPercent === next.progressPercent;
}

function buildAssessmentTimingComment(content: PactContent, progress: PactContentProgress | undefined, submittedAt: string) {
  if (content.type !== "assessment") return undefined;
  if (content.mechanics?.kind === "readiness_checklist" && content.mechanics.timing?.enabled === false) return undefined;

  const startedAt = assessmentStartedAt(progress);
  const elapsedSeconds = startedAt ? Math.max(0, Math.round((Date.parse(submittedAt) - Date.parse(startedAt)) / 1000)) : undefined;
  const timing = content.mechanics?.kind === "readiness_checklist" ? content.mechanics.timing : undefined;
  const timeLimitSeconds = timing?.timeLimitSeconds;
  const payload = {
    pactAssessmentTiming: {
      contentId: content.id,
      contentType: content.type,
      startTrigger: timing?.startTrigger ?? "learner_start",
      submitTrigger: timing?.submitTrigger ?? "content_submit",
      startedAt,
      submittedAt,
      elapsedSeconds,
      timeLimitSeconds,
      expired: typeof elapsedSeconds === "number" && typeof timeLimitSeconds === "number" ? elapsedSeconds > timeLimitSeconds : undefined
    }
  };
  return JSON.stringify(payload);
}

function assessmentStartedAt(progress: PactContentProgress | undefined) {
  const mechanicsStartedAt = progress?.mechanicsState?.startedAt;
  if (typeof mechanicsStartedAt === "string" && Number.isFinite(Date.parse(mechanicsStartedAt))) {
    return mechanicsStartedAt;
  }
  if (progress?.startedAt && Number.isFinite(Date.parse(progress.startedAt))) {
    return progress.startedAt;
  }
  return undefined;
}

const AGS_SCORE_SCOPE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";
const AGS_LINE_ITEM_SCOPE = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem";

function shouldSchedulePersistentRetry(config: AppConfig, retryCount: number) {
  return config.agsAutoRetryEnabled && retryCount < config.agsAutoRetryMaxAttempts;
}

function shouldMarkRetryExhausted(config: AppConfig, retryCount: number) {
  return config.agsAutoRetryEnabled && config.agsAutoRetryMaxAttempts > 0 && retryCount >= config.agsAutoRetryMaxAttempts;
}

function retryDelayMs(config: AppConfig, attemptNumber: number) {
  const delay = config.agsAutoRetryInitialDelayMs * (2 ** Math.max(0, attemptNumber - 1));
  return Math.min(delay, config.agsAutoRetryMaxDelayMs);
}
