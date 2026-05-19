import type { Db, Filter } from "mongodb";
import type { AppConfig } from "../config/config.js";
import { collectionName } from "../db/mongo.js";
import { AppError } from "../errors/AppError.js";
import type { ContentMechanics, ContentStatus, ContentType, PactAgsContext, PactAgsPublishAttempt, PactAnswerValue, PactAuditEvent, PactBugReport, PactContent, PactContentProgress, PactMechanicsState, PactNotification, PactQuestionAttempt, PactQuestionGrade, PactRole, PactScore, PactUser, Squad, SquadNumber } from "../domain/types.js";

export class PactRepository {
  constructor(private readonly db: Db, private readonly config: AppConfig) {}

  async upsertUser(input: Omit<PactUser, "id" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    const existing = await this.users().findOne({ lmsUserId: input.lmsUserId });
    const user: PactUser = {
      id: existing?.id ?? crypto.randomUUID(),
      ...input,
      squadId: input.squadId ?? existing?.squadId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.users().updateOne({ lmsUserId: input.lmsUserId }, { $set: user }, { upsert: true });
    return user;
  }

  async getUser(userId: string) {
    return this.users().findOne({ id: userId });
  }

  async requireUser(userId: string) {
    const user = await this.getUser(userId);
    if (!user) throw new AppError(404, "PACT_USER_NOT_FOUND", "PACT user was not found");
    return user;
  }

  async getSquad(squadId: string) {
    return this.squads().findOne({ id: squadId });
  }

  async createSquad(input: { courseId: string; cohortId: string; name: string }) {
    const now = new Date().toISOString();
    const existing = await this.squads().findOne(input);
    if (existing) return existing;
    const squad: Squad = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
    await this.squads().insertOne(squad);
    return squad;
  }

  async createBugReport(input: Omit<PactBugReport, "id" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    const report: PactBugReport = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now
    };
    await this.bugReports().insertOne(report);
    return report;
  }

  async updateBugReportLinearSync(reportId: string, input: {
    linearIssueId?: string;
    linearIssueIdentifier?: string;
    linearIssueUrl?: string;
    linearIssueState?: string;
    syncStatus: PactBugReport["syncStatus"];
    syncError?: string;
  }) {
    const updatedAt = new Date().toISOString();
    await this.bugReports().updateOne(
      { id: reportId },
      {
        $set: {
          ...input,
          updatedAt
        },
        $unset: input.syncError ? {} : { syncError: "" }
      }
    );
    const report = await this.bugReports().findOne({ id: reportId });
    if (!report) throw new AppError(404, "BUG_REPORT_NOT_FOUND", "Bug report was not found");
    return report;
  }

  async syncBugReportFromLinearIssue(input: {
    linearIssueId: string;
    linearIssueIdentifier?: string;
    linearIssueUrl?: string;
    linearIssueState?: string;
  }) {
    const updatedAt = new Date().toISOString();
    const result = await this.bugReports().updateOne(
      { linearIssueId: input.linearIssueId },
      {
        $set: {
          linearIssueIdentifier: input.linearIssueIdentifier,
          linearIssueUrl: input.linearIssueUrl,
          linearIssueState: input.linearIssueState,
          syncStatus: "synced",
          updatedAt
        },
        $unset: { syncError: "" }
      }
    );
    return { matched: result.matchedCount, modified: result.modifiedCount };
  }

  async listAdminCohorts(session: { role: PactRole; courseId: string; cohortId: string }) {
    const filter: Record<string, string> = { courseId: session.courseId };

    const users = await this.users()
      .find(filter)
      .sort({ cohortId: 1, role: 1, name: 1, email: 1 })
      .toArray();
    const squads = await this.squads()
      .find(filter)
      .sort({ cohortId: 1, number: 1, name: 1 })
      .toArray();
    const cohortIds = Array.from(new Set([session.cohortId, ...users.map((user) => user.cohortId), ...squads.map((squad) => squad.cohortId)])).sort();

    return cohortIds.map((cohortId) => ({
      courseId: session.courseId,
      cohortId,
      squads: squads
        .filter((squad) => squad.cohortId === cohortId)
        .map((squad) => ({
          id: squad.id,
          name: squad.name,
          number: squad.number ?? squadNumberFromName(squad.name)
        })),
      users: users
        .filter((user) => user.cohortId === cohortId)
        .map((user) => ({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          cohortId: user.cohortId,
          squadId: user.squadId,
          squadNumber: squadNumberForUser(user, squads)
        }))
    }));
  }

  async listChallengeSubmissionsForReview(input: { contentId: string; session: { role: PactRole; courseId: string; cohortId: string } }) {
    const content = await this.content().findOne({ id: input.contentId, courseId: input.session.courseId });
    if (!content) throw new AppError(404, "CONTENT_NOT_FOUND", "Content was not found");
    if (!isReviewableSubmissionContent(content)) {
      throw new AppError(400, "CONTENT_NOT_REVIEWABLE", "Only challenge synthesis or workshop response content can be reviewed");
    }

    const cohortFilter = content.cohortId ? { cohortId: content.cohortId } : {};
    const [users, squads, progress] = await Promise.all([
      this.users()
        .find({ courseId: input.session.courseId, role: "learner", ...cohortFilter })
        .sort({ cohortId: 1, name: 1, email: 1 })
        .toArray(),
      this.squads().find({ courseId: input.session.courseId }).toArray(),
      this.contentProgress().find({ courseId: input.session.courseId, contentId: input.contentId }).toArray()
    ]);
    const reviewPrompts = reviewPromptsForContent(content, progress);
    if (!reviewPrompts.length) {
      throw new AppError(400, "CONTENT_NOT_REVIEWABLE", "Only challenge synthesis or workshop response content can be reviewed");
    }
    const userProgress = progress.filter((item) => item.scope === "user" || !item.scope);
    const squadProgress = progress.filter((item) => item.scope === "squad" && item.squadId);
    const progressByUserId = new Map(userProgress.map((item) => [item.userId, item]));
    const progressBySquadId = new Map(squadProgress.map((item) => [item.squadId, item]));
    const submissions = users.map((user) => {
      const progressRecord = progressBySquadId.get(user.squadId ?? "") ?? progressByUserId.get(user.id);
      const reviewResponses = reviewResponsesForProgress(content, progressRecord);
      const completedPromptIds = reviewPrompts
        .filter((prompt) => (reviewResponses[prompt.id] ?? "").trim().length > 0)
        .map((prompt) => prompt.id);

      return {
        userId: user.id,
        lmsUserId: user.lmsUserId,
        learnerName: user.name ?? user.email ?? user.id,
        email: user.email,
        cohortId: user.cohortId,
        squadId: user.squadId,
        squadNumber: squadNumberForUser(user, squads),
        status: progressRecord?.status ?? "not_started",
        progressPercent: progressRecord?.progressPercent ?? 0,
        completedPromptIds,
        responses: reviewPrompts.map((prompt) => ({
          promptId: prompt.id,
          label: prompt.label,
          prompt: prompt.prompt,
          required: prompt.required !== false,
          response: reviewResponses[prompt.id] ?? ""
        })),
        updatedAt: progressRecord?.updatedAt,
        submittedAt: progressRecord?.submittedAt
        
      };
    });

    // attach any existing scores for the content to the submissions
    const scores = await this.scores().find({ courseId: input.session.courseId, contentId: input.contentId }).toArray();
    const scoresByUser = new Map(scores.map((s) => [s.userId, s]));
    for (const submission of submissions) {
      const s = scoresByUser.get(submission.userId);
      if (s) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (submission as any).score = s.score;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (submission as any).maxScore = s.maxScore;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (submission as any).agsStatus = s.agsStatus;
      }
    }

    const squadKeys = Array.from(new Set(submissions.map((submission) => submission.squadNumber ?? submission.squadId ?? "unassigned"))).sort();
    return {
      content: {
        id: content.id,
        title: content.title,
        cohortId: content.cohortId ?? null
      },
      prompts: reviewPrompts.map((prompt) => ({
        id: prompt.id,
        label: prompt.label,
        prompt: prompt.prompt,
        required: prompt.required !== false
      })),
      squads: squadKeys.map((key) => ({
        key,
        label: key === "unassigned" ? "Unassigned" : `Squad ${key}`,
        submissions: submissions.filter((submission) => (submission.squadNumber ?? submission.squadId ?? "unassigned") === key)
      }))
    };
  }

  async listAdminAuditEvents(input: {
    session: { courseId: string };
    action?: PactAuditEvent["action"];
    limit: number;
  }) {
    const filter: Record<string, unknown> = { courseId: input.session.courseId };
    if (input.action) filter.action = input.action;
    const events = await this.auditEvents()
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(input.limit)
      .toArray();
    const userIds = Array.from(new Set(events.flatMap((event) => [event.actorUserId, event.targetUserId])));
    const users = await this.users()
      .find({ courseId: input.session.courseId, id: { $in: userIds } })
      .project<Pick<PactUser, "id" | "name" | "email" | "role">>({ _id: 0, id: 1, name: 1, email: 1, role: 1 })
      .toArray();
    const usersById = new Map(users.map((user) => [user.id, user]));

    return events.map((event) => {
      const actor = usersById.get(event.actorUserId);
      const target = usersById.get(event.targetUserId);
      return {
        id: event.id,
        action: event.action,
        actorUserId: event.actorUserId,
        actorName: actor?.name ?? actor?.email,
        targetUserId: event.targetUserId,
        targetName: target?.name ?? target?.email,
        courseId: event.courseId,
        cohortId: event.cohortId,
        metadata: event.metadata,
        previousSquadId: event.metadata.previousSquadId,
        nextSquadId: event.metadata.nextSquadId,
        nextSquadNumber: event.metadata.nextSquadNumber,
        contentId: event.metadata.contentId,
        questionId: event.metadata.questionId,
        attemptId: event.metadata.attemptId,
        previousScore: event.metadata.previousScore,
        nextScore: event.metadata.nextScore,
        maxScore: event.metadata.maxScore,
        previousIsCorrect: event.metadata.previousIsCorrect,
        nextIsCorrect: event.metadata.nextIsCorrect,
        feedbackChanged: event.metadata.feedbackChanged,
        scanned: event.metadata.scanned,
        retried: event.metadata.retried,
        failed: event.metadata.failed,
        exhausted: event.metadata.exhausted,
        limit: event.metadata.limit,
        createdAt: event.createdAt
      };
    });
  }

  async assignSquad(userId: string, squadId: string) {
    const user = await this.requireUser(userId);
    const squad = await this.squads().findOne({ id: squadId, courseId: user.courseId, cohortId: user.cohortId });
    if (!squad) throw new AppError(400, "INVALID_SQUAD_ASSIGNMENT", "Squad does not belong to the user's course and cohort");
    const updatedAt = new Date().toISOString();
    await this.users().updateOne({ id: userId }, { $set: { squadId, updatedAt } });
    await this.carryLearnerSquadHistory({ user, nextSquadId: squadId, updatedAt });
    return { ...user, squadId, updatedAt };
  }

  async assignSquadForAdmin(userId: string, input: { squadId?: string; squadNumber?: SquadNumber; session: { userId: string; role: PactRole; courseId: string; cohortId: string } }) {
    const user = await this.requireUser(userId);
    if (user.courseId !== input.session.courseId) {
      throw new AppError(403, "USER_FORBIDDEN", "User is not assigned to this course");
    }
    if (user.role !== "learner") {
      throw new AppError(400, "INVALID_SQUAD_ASSIGNMENT", "Only learners can be assigned to squads");
    }

    const squad = input.squadNumber
      ? await this.ensureNumberedSquad(user.courseId, user.cohortId, input.squadNumber)
      : await this.squads().findOne({ id: input.squadId, courseId: user.courseId, cohortId: user.cohortId });
    if (!squad) throw new AppError(400, "INVALID_SQUAD_ASSIGNMENT", "Squad does not belong to the user's course and cohort");

    const updatedAt = new Date().toISOString();
    await this.users().updateOne({ id: userId }, { $set: { squadId: squad.id, updatedAt } });
    const carried = await this.carryLearnerSquadHistory({ user, nextSquadId: squad.id, updatedAt });
    await this.auditEvents().insertOne({
      id: crypto.randomUUID(),
      action: "squad.assignment.changed",
      actorUserId: input.session.userId,
      targetUserId: user.id,
      courseId: user.courseId,
      cohortId: user.cohortId,
      metadata: {
        previousSquadId: user.squadId,
        nextSquadId: squad.id,
        nextSquadNumber: squad.number ?? squadNumberFromName(squad.name),
        carriedScores: carried.scores,
        carriedProgress: carried.progress,
        carriedQuestionAttempts: carried.questionAttempts,
        carriedAgsPublishAttempts: carried.agsPublishAttempts
      },
      createdAt: updatedAt
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      courseId: user.courseId,
      cohortId: user.cohortId,
      squadId: squad.id,
      updatedAt
    };
  }

  private async ensureNumberedSquad(courseId: string, cohortId: string, number: SquadNumber) {
    const now = new Date().toISOString();
    const existing = await this.squads().findOne({ courseId, cohortId, number });
    if (existing) return existing;

    const squad: Squad = {
      id: crypto.randomUUID(),
      courseId,
      cohortId,
      name: `Squad ${number}`,
      number,
      createdAt: now,
      updatedAt: now
    };
    await this.squads().insertOne(squad);
    return squad;
  }

  private async carryLearnerSquadHistory(input: { user: PactUser; nextSquadId: string; updatedAt: string }) {
    if (input.user.squadId === input.nextSquadId) {
      return { scores: 0, progress: 0, questionAttempts: 0, agsPublishAttempts: 0 };
    }
    const baseFilter = {
      userId: input.user.id,
      courseId: input.user.courseId,
      cohortId: input.user.cohortId
    };
    const progressFilter = {
      ...baseFilter,
      $or: [{ scope: "user" as const }, { scope: { $exists: false } }]
    };
    const [scores, progress, questionAttempts, agsPublishAttempts] = await Promise.all([
      this.scores().updateMany(baseFilter, { $set: { squadId: input.nextSquadId, updatedAt: input.updatedAt } }),
      this.contentProgress().updateMany(progressFilter, { $set: { squadId: input.nextSquadId, updatedAt: input.updatedAt } }),
      this.questionAttempts().updateMany(baseFilter, { $set: { squadId: input.nextSquadId } }),
      this.agsPublishAttempts().updateMany(baseFilter, { $set: { squadId: input.nextSquadId, updatedAt: input.updatedAt } })
    ]);

    return {
      scores: scores.modifiedCount,
      progress: progress.modifiedCount,
      questionAttempts: questionAttempts.modifiedCount,
      agsPublishAttempts: agsPublishAttempts.modifiedCount
    };
  }

  async upsertContent(input: Omit<PactContent, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();
    const existing = await this.content().findOne({ id });
    const content: PactContent = {
      ...input,
      locked: input.locked ?? existing?.locked ?? true,
      id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.content().updateOne({ id }, { $set: content }, { upsert: true });
    return content;
  }

  async upsertContentForManagement(input: Omit<PactContent, "id" | "createdAt" | "updatedAt"> & { id?: string }, session: { role: PactRole; courseId: string; cohortId: string }) {
    if (input.courseId !== session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this course");
    }

    return this.upsertContent(input);
  }

  async listContentFor(user: PactUser, contentType?: ContentType, contentId?: string) {
    if (user.role === "admin") {
      const content = await this.content()
        .find({ courseId: user.courseId })
        .sort({ type: 1, title: 1 })
        .toArray();
      return content.map(normalizeContentDefaults);
    }

    if (user.role === "instructor") {
      const content = await this.content()
        .find({ courseId: user.courseId })
        .sort({ type: 1, title: 1 })
        .toArray();
      return content.map(normalizeContentDefaults);
    }

    const content = await this.content()
      .find({
        courseId: user.courseId,
        status: "published",
        locked: false,
        role: { $in: [user.role, "all"] },
        $or: globalOrCohortFilter(user.cohortId)
      })
      .sort({ type: 1, title: 1 })
      .toArray();
    return content.map(normalizeContentDefaults);
  }

  async listDeepLinkableContent(courseId?: string) {
    return this.content()
      .find({
        ...(courseId ? { courseId } : {}),
        status: "published",
        locked: false,
        type: { $in: ["assessment"] }
      })
      .sort({ type: 1, title: 1 })
      .toArray();
  }

  async listContentForManagement(session: { role: PactRole; courseId: string; cohortId: string }) {
    const filter: Record<string, unknown> = { courseId: session.courseId };

    const content = await this.content()
      .find(filter)
      .sort({ type: 1, title: 1 })
      .toArray();
    return content.map(normalizeContentDefaults);
  }

  async listLmsLabelsForDeepLink(courseId?: string) {
    const filter: Record<string, unknown> = { lmsLabel: { $exists: true, $type: "string" } };
    if (courseId) {
      filter.courseId = courseId;
    }

    const content = await this.content()
      .find(filter)
      .sort({ updatedAt: -1, title: 1 })
      .toArray();
    const labels: Partial<Record<ContentType, string>> = {};
    for (const item of content) {
      if (!labels[item.type] && item.lmsLabel) {
        labels[item.type] = item.lmsLabel;
      }
    }
    return labels;
  }

  async listContentCountsForDiagnostics(session: { role: PactRole; courseId: string; cohortId: string }) {
    const match: Record<string, unknown> = { courseId: session.courseId };

    return this.content().aggregate<{
      courseId: string;
      cohortId: string | null;
      type: ContentType;
      status: ContentStatus;
      count: number;
      questions: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: {
            courseId: "$courseId",
            cohortId: { $ifNull: ["$cohortId", null] },
            type: "$type",
            status: "$status"
          },
          count: { $sum: 1 },
          questions: { $sum: { $ifNull: ["$questionCount", { $size: { $ifNull: ["$questions", []] } }] } }
        }
      },
      {
        $project: {
          _id: 0,
          courseId: "$_id.courseId",
          cohortId: "$_id.cohortId",
          type: "$_id.type",
          status: "$_id.status",
          count: 1,
          questions: 1
        }
      },
      { $sort: { courseId: 1, cohortId: 1, type: 1, status: 1 } }
    ]).toArray();
  }

  async listContentAccessDiagnostics(session: { role: PactRole; courseId: string; cohortId: string; contentType?: ContentType; contentId?: string }) {
    const content = await this.content()
      .find({ courseId: session.courseId })
      .sort({ type: 1, title: 1 })
      .toArray();

    return content.map((item) => {
      const checks = [
        {
          code: "published",
          label: item.status === "published" ? "Published" : `Status is ${item.status ?? "draft"}`,
          passed: item.status === "published"
        },
        {
          code: "unlocked",
          label: item.locked === false ? "Unlocked for learners" : "Locked by instructor/admin",
          passed: item.locked === false
        },
        {
          code: "learner_role",
          label: item.role === "learner" || item.role === "all" ? `Visible to ${item.role}` : `Role target is ${item.role}`,
          passed: item.role === "learner" || item.role === "all"
        },
        {
          code: "cohort_scope",
          label: cohortMatches(item.cohortId, session.cohortId) ? `Matches ${item.cohortId ?? "all cohorts"}` : `Assigned to ${item.cohortId}`,
          passed: cohortMatches(item.cohortId, session.cohortId)
        },
        {
          code: "launch_type",
          label: session.contentType ? `Launch type ${session.contentType} does not restrict dashboard content` : "No launch type restriction",
          passed: true
        },
        {
          code: "launch_content",
          label: session.contentId ? `Launch content ${session.contentId} does not restrict dashboard content` : "No launch content restriction",
          passed: true
        }
      ];

      return {
        contentId: item.id,
        title: item.title,
        type: item.type,
        status: item.status,
        locked: item.locked ?? true,
        cohortId: item.cohortId ?? null,
        role: item.role,
        learnerVisible: checks.every((check) => check.passed),
        checks,
        blockers: checks.filter((check) => !check.passed).map((check) => check.code)
      };
    });
  }

  async lockPublishedContentForManagement(session: { role: PactRole; courseId: string; cohortId: string }) {
    const updatedAt = new Date().toISOString();
    const filter: Filter<PactContent> = {
      courseId: session.courseId,
      status: "published",
      locked: { $ne: true }
    };
    const matched = await this.content().countDocuments(filter);
    const result = await this.content().updateMany(filter, { $set: { locked: true, updatedAt } });
    return {
      matched,
      modified: result.modifiedCount,
      updatedAt
    };
  }

  async countPublishedModulesForCourse(courseId: string) {
    return this.content().countDocuments({
      courseId,
      type: "module",
      status: "published",
      locked: false
    });
  }

  async requireContent(contentId: string) {
    const content = await this.content().findOne({ id: contentId });
    if (!content) throw new AppError(404, "CONTENT_NOT_FOUND", "PACT content was not found");
    return content;
  }

  async updateContentStatus(input: { contentId: string; status: ContentStatus; session: { role: PactRole; courseId: string; cohortId: string } }) {
    const content = await this.requireContent(input.contentId);
    if (content.courseId !== input.session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this course");
    }

    const updatedAt = new Date().toISOString();
    await this.content().updateOne({ id: input.contentId }, { $set: { status: input.status, updatedAt } });
    return { ...content, status: input.status, updatedAt };
  }

  async updateContentLock(input: { contentId: string; locked: boolean; session: { role: PactRole; courseId: string; cohortId: string } }) {
    const content = await this.requireContent(input.contentId);
    if (content.courseId !== input.session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this course");
    }

    const updatedAt = new Date().toISOString();
    await this.content().updateOne({ id: input.contentId }, { $set: { locked: input.locked, updatedAt } });
    return { ...content, locked: input.locked, updatedAt };
  }

  async updateContentDeck(input: { contentId: string; deck: PactContent["deck"]; session: { role: PactRole; courseId: string; cohortId: string } }) {
    const content = await this.requireContent(input.contentId);
    if (content.courseId !== input.session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this course");
    }
    const updatedAt = new Date().toISOString();
    await this.content().updateOne({ id: input.contentId, courseId: input.session.courseId }, { $set: { deck: input.deck, updatedAt } });
    return { ...content, deck: input.deck, updatedAt };
  }

  async updateContentDeckLock(input: { contentId: string; unlocked: boolean; session: { role: PactRole; courseId: string; cohortId: string } }) {
    const content = await this.requireContent(input.contentId);
    if (content.courseId !== input.session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this course");
    }
    const deck = content.deck ?? { unlocked: false, files: [] };
    const updatedAt = new Date().toISOString();
    const nextDeck = { ...deck, unlocked: input.unlocked };
    await this.content().updateOne({ id: input.contentId, courseId: input.session.courseId }, { $set: { deck: nextDeck, updatedAt } });
    return { ...content, deck: nextDeck, updatedAt };
  }

  async updateContentAssignment(input: { contentId: string; cohortId: string | null; session: { role: PactRole; courseId: string; cohortId: string } }) {
    const content = await this.requireContent(input.contentId);
    if (content.courseId !== input.session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this course");
    }

    const updatedAt = new Date().toISOString();
    await this.content().updateOne({ id: input.contentId }, { $set: { cohortId: input.cohortId, updatedAt } });
    return { ...content, cohortId: input.cohortId, updatedAt };
  }

  async updateContentLmsLabel(input: { contentId: string; lmsLabel: string | null; session: { role: PactRole; courseId: string; cohortId: string } }) {
    const content = await this.requireContent(input.contentId);
    if (content.courseId !== input.session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this course");
    }

    const updatedAt = new Date().toISOString();
    const update = input.lmsLabel
      ? { $set: { lmsLabel: input.lmsLabel, updatedAt } }
      : { $unset: { lmsLabel: 1 as const }, $set: { updatedAt } };
    await this.content().updateOne({ id: input.contentId }, update);
    return input.lmsLabel ? { ...content, lmsLabel: input.lmsLabel, updatedAt } : { ...content, lmsLabel: undefined, updatedAt };
  }

  async updateContentMechanics(input: { contentId: string; mechanics: ContentMechanics | null; session: { role: PactRole; courseId: string; cohortId: string } }) {
    const content = await this.requireContent(input.contentId);
    if (content.courseId !== input.session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is outside this course");
    }
    if (input.mechanics && !mechanicsMatchesContentType(content.type, input.mechanics.kind)) {
      throw new AppError(400, "MECHANICS_TYPE_MISMATCH", "Mechanics kind does not match content type");
    }
    const updatedAt = new Date().toISOString();
    const availability = mechanicsUnlocksChallenge(input.mechanics)
      ? { status: "published" as const, locked: false }
      : {};
    const update = input.mechanics
      ? { $set: { mechanics: input.mechanics, updatedAt, ...availability } }
      : { $unset: { mechanics: 1 as const }, $set: { updatedAt } };
    await this.content().updateOne({ id: input.contentId }, update);
    return input.mechanics ? { ...content, mechanics: input.mechanics, updatedAt, ...availability } : { ...content, mechanics: undefined, updatedAt };
  }

  async importContentReleaseMechanics(input: { contentId: string; mechanics: ContentMechanics; session: { role: PactRole; courseId: string; cohortId: string } }) {
    const content = await this.requireContent(input.contentId);
    if (content.courseId !== input.session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is outside this course");
    }
    if (content.type !== "challenge" || input.mechanics.kind !== "challenge_path") {
      throw new AppError(400, "MECHANICS_TYPE_MISMATCH", "Release imports are only supported for challenge content");
    }
    const updatedAt = new Date().toISOString();
    const availability = mechanicsUnlocksChallenge(input.mechanics)
      ? { status: "published" as const, locked: false }
      : {};
    await this.content().updateOne(
      { id: input.contentId, courseId: input.session.courseId, type: "challenge" },
      { $set: { mechanics: input.mechanics, updatedAt, ...availability } }
    );
    return { ...content, mechanics: input.mechanics, updatedAt, ...availability };
  }

  async upsertScore(input: {
    user: PactUser;
    contentId: string;
    contentType: ContentType;
    score: number;
    maxScore: number;
    progressPercent: number;
    agsStatus: PactScore["agsStatus"];
  }) {
    const now = new Date().toISOString();
    const existing = await this.scores().findOne({ userId: input.user.id, contentId: input.contentId });
    const score: PactScore = {
      id: existing?.id ?? crypto.randomUUID(),
      courseId: input.user.courseId,
      cohortId: input.user.cohortId,
      squadId: input.user.squadId,
      userId: input.user.id,
      contentId: input.contentId,
      contentType: input.contentType,
      score: input.score,
      maxScore: input.maxScore,
      progressPercent: input.progressPercent,
      agsStatus: input.agsStatus,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.scores().updateOne({ userId: input.user.id, contentId: input.contentId }, { $set: score }, { upsert: true });
    return score;
  }

  async getScoreForUserContent(userId: string, contentId: string) {
    return this.scores().findOne({ userId, contentId });
  }

  async updateContentLineItemUrl(contentId: string, lineItemUrl: string) {
    const updatedAt = new Date().toISOString();
    await this.content().updateOne({ id: contentId }, { $set: { lineItemUrl, updatedAt } });
  }

  async upsertAgsContext(input: Omit<PactAgsContext, "id" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    const existing = await this.agsContexts().findOne({
      userId: input.userId,
      courseId: input.courseId,
      cohortId: input.cohortId
    });
    const context: PactAgsContext = {
      id: existing?.id ?? crypto.randomUUID(),
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.agsContexts().updateOne(
      { userId: input.userId, courseId: input.courseId, cohortId: input.cohortId },
      { $set: context },
      { upsert: true }
    );
    return context;
  }

  async getAgsContextForUser(input: { userId: string; courseId: string; cohortId: string }) {
    return this.agsContexts().findOne(input);
  }

  async getLatestAgsContextForCourseCohort(input: { courseId: string; cohortId: string }) {
    return this.agsContexts()
      .findOne(input, { sort: { updatedAt: -1 } });
  }

  async recordAgsPublishAttempt(input: Omit<PactAgsPublishAttempt, "id" | "createdAt">) {
    const now = new Date().toISOString();
    const attempt: PactAgsPublishAttempt = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: input.updatedAt ?? now
    };
    await this.agsPublishAttempts().insertOne(attempt);
    return attempt;
  }

  async findAgsPublishAttempt(input: {
    userId: string;
    contentId: string;
    score: number;
    maxScore: number;
    progressPercent: number;
    status: PactAgsPublishAttempt["status"];
  }) {
    return this.agsPublishAttempts().findOne(input, { sort: { createdAt: -1 } });
  }

  async getAgsPublishAttemptForCourse(attemptId: string, courseId: string) {
    return this.agsPublishAttempts().findOne({ id: attemptId, courseId });
  }

  async listAgsPublishAttemptsForDiagnostics(input: {
    session: { courseId: string; cohortId: string };
    status?: PactAgsPublishAttempt["status"];
    cohortId?: string;
    contentId?: string;
    userId?: string;
    cursor?: string;
    limit: number;
  }) {
    const filter: Record<string, unknown> = { courseId: input.session.courseId };
    if (input.status) filter.status = input.status;
    if (input.cohortId) filter.cohortId = input.cohortId;
    if (input.contentId) filter.contentId = input.contentId;
    if (input.userId) filter.userId = input.userId;
    if (input.cursor) filter.createdAt = { $lt: input.cursor };

    const attempts = await this.agsPublishAttempts()
      .find(filter)
      .project<Omit<PactAgsPublishAttempt, "_id">>({ _id: 0 })
      .sort({ createdAt: -1 })
      .limit(input.limit + 1)
      .toArray();
    const statusCounts = await this.agsPublishAttempts().aggregate<{ status: PactAgsPublishAttempt["status"]; count: number }>([
      { $match: withoutCursor(filter) },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $project: { _id: 0, status: "$_id", count: 1 } }
    ]).toArray();
    const hasMore = attempts.length > input.limit;
    const page = hasMore ? attempts.slice(0, input.limit) : attempts;
    return {
      attempts: page,
      nextCursor: hasMore ? page.at(-1)?.createdAt : undefined,
      summary: {
        total: statusCounts.reduce((total, item) => total + item.count, 0),
        byStatus: Object.fromEntries(statusCounts.map((item) => [item.status, item.count]))
      }
    };
  }

  async listAgsPublishAttemptsForExport(input: {
    session: { courseId: string; cohortId: string };
    status?: PactAgsPublishAttempt["status"];
    cohortId?: string;
    contentId?: string;
    userId?: string;
    limit: number;
  }) {
    const filter: Record<string, unknown> = { courseId: input.session.courseId };
    if (input.status) filter.status = input.status;
    if (input.cohortId) filter.cohortId = input.cohortId;
    if (input.contentId) filter.contentId = input.contentId;
    if (input.userId) filter.userId = input.userId;

    return this.agsPublishAttempts()
      .find(filter)
      .project<Omit<PactAgsPublishAttempt, "_id">>({ _id: 0 })
      .sort({ createdAt: -1 })
      .limit(input.limit)
      .toArray();
  }

  async listDueAgsPublishAttempts(input: { nowIso: string; limit: number; courseId?: string }) {
    return this.agsPublishAttempts()
      .find({
        ...(input.courseId ? { courseId: input.courseId } : {}),
        status: { $in: ["failed", "pending"] },
        nextRetryAt: { $lte: input.nowIso }
      })
      .project<Omit<PactAgsPublishAttempt, "_id">>({ _id: 0 })
      .sort({ nextRetryAt: 1, createdAt: 1 })
      .limit(input.limit)
      .toArray();
  }

  async listSubmittedUserProgressForAgsBackfill(input: { courseId: string; cohortId?: string; limit: number }) {
    return this.contentProgress()
      .find({
        courseId: input.courseId,
        ...(input.cohortId ? { cohortId: input.cohortId } : {}),
        status: "submitted",
        score: { $exists: true },
        maxScore: { $exists: true },
        $or: [{ scope: "user" }, { scope: { $exists: false } }]
      })
      .project<Omit<PactContentProgress, "_id">>({ _id: 0 })
      .sort({ submittedAt: -1, updatedAt: -1 })
      .limit(input.limit)
      .toArray();
  }

  async listNotApplicableAgsAttemptsForBackfill(input: { courseId: string; cohortId?: string; limit: number }) {
    return this.agsPublishAttempts()
      .find({
        courseId: input.courseId,
        ...(input.cohortId ? { cohortId: input.cohortId } : {}),
        status: "not_applicable"
      })
      .project<Omit<PactAgsPublishAttempt, "_id">>({ _id: 0 })
      .sort({ createdAt: -1 })
      .limit(input.limit)
      .toArray();
  }

  async recordManualAgsQueueProcessingAudit(input: {
    session: { userId: string; courseId: string; cohortId: string };
    result: { scanned: number; retried: number; failed: number; exhausted: number };
    limit: number;
  }) {
    await this.auditEvents().insertOne({
      id: crypto.randomUUID(),
      action: "ags.queue.process_due.triggered",
      actorUserId: input.session.userId,
      targetUserId: input.session.userId,
      courseId: input.session.courseId,
      cohortId: input.session.cohortId,
      metadata: {
        ...input.result,
        limit: input.limit
      },
      createdAt: new Date().toISOString()
    });
  }

  async updateAgsPublishAttemptOutcome(input: {
    id: string;
    status: PactAgsPublishAttempt["status"];
    retryCount?: number;
    nextRetryAt?: string;
    errorCode?: string;
    errorMessage?: string;
  }) {
    const set: Partial<PactAgsPublishAttempt> = {
      status: input.status,
      retryCount: input.retryCount,
      updatedAt: new Date().toISOString()
    };
    const unset: Record<string, ""> = {};
    if (input.nextRetryAt) set.nextRetryAt = input.nextRetryAt;
    else unset.nextRetryAt = "";
    if (input.errorCode) set.errorCode = input.errorCode;
    else unset.errorCode = "";
    if (input.errorMessage) set.errorMessage = input.errorMessage;
    else unset.errorMessage = "";
    const update = Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set };
    await this.agsPublishAttempts().updateOne({ id: input.id }, update);
    return this.agsPublishAttempts().findOne({ id: input.id });
  }

  async countExhaustedAgsPublishAttempts(input: { courseId: string; cohortId?: string }) {
    return this.agsPublishAttempts().countDocuments({
      courseId: input.courseId,
      ...(input.cohortId ? { cohortId: input.cohortId } : {}),
      status: "retry_exhausted"
    });
  }

  async deleteAgsPublishAttemptsBefore(cutoffIso: string) {
    const result = await this.agsPublishAttempts().deleteMany({ createdAt: { $lt: cutoffIso } });
    return result.deletedCount;
  }

  async enqueueNotification(input: Pick<PactNotification, "event" | "sinkUrl" | "payload">) {
    const now = new Date().toISOString();
    const notification: PactNotification = {
      id: crypto.randomUUID(),
      ...input,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now
    };
    await this.notifications().insertOne(notification);
    return notification;
  }

  async listDueNotifications(input: { nowIso: string; limit: number }) {
    return this.notifications()
      .find({ status: "pending", nextAttemptAt: { $lte: input.nowIso } })
      .project<Omit<PactNotification, "_id">>({ _id: 0 })
      .sort({ nextAttemptAt: 1, createdAt: 1 })
      .limit(input.limit)
      .toArray();
  }

  async markNotificationDelivered(id: string) {
    const now = new Date().toISOString();
    await this.notifications().updateOne(
      { id },
      {
        $set: {
          status: "delivered",
          updatedAt: now
        },
        $unset: { lastError: "", lastStatus: "" }
      }
    );
  }

  async markNotificationFailed(input: { id: string; attemptCount: number; nextAttemptAt?: string; deadLetter: boolean; status?: number; error?: string }) {
    const now = new Date().toISOString();
    await this.notifications().updateOne(
      { id: input.id },
      {
        $set: {
          status: input.deadLetter ? "dead_letter" : "pending",
          attemptCount: input.attemptCount,
          updatedAt: now,
          ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
          ...(input.status ? { lastStatus: input.status } : {}),
          ...(input.error ? { lastError: input.error } : {})
        }
      }
    );
  }

  async listNotificationsForDiagnostics(input: { status: PactNotification["status"]; event?: PactNotification["event"]; limit: number }) {
    return this.notifications()
      .find({
        status: input.status,
        ...(input.event ? { event: input.event } : {})
      })
      .project<Omit<PactNotification, "_id">>({ _id: 0 })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(input.limit)
      .toArray();
  }

  async listProgressForUser(user: PactUser, contentIds: string[]) {
    if (!contentIds.length) return [];
    return this.contentProgress()
      .find({
        userId: user.id,
        courseId: user.courseId,
        cohortId: user.cohortId,
        contentId: { $in: contentIds },
        $or: [{ scope: "user" }, { scope: { $exists: false } }]
      })
      .sort({ updatedAt: -1 })
      .toArray();
  }

  async listProgressForSquad(user: PactUser, contentIds: string[]) {
    if (!contentIds.length || !user.squadId) return [];
    return this.contentProgress()
      .find({
        scope: "squad",
        courseId: user.courseId,
        cohortId: user.cohortId,
        squadId: user.squadId,
        contentId: { $in: contentIds }
      })
      .sort({ updatedAt: -1 })
      .toArray();
  }

  async upsertContentProgress(input: {
    user: PactUser;
    content: PactContent;
    answers?: Record<string, PactAnswerValue>;
    mechanicsState?: PactMechanicsState;
    progressPercent?: number;
    status?: PactContentProgress["status"];
    startedAt?: string;
    submittedAt?: string;
    score?: number;
    maxScore?: number;
  }) {
    const now = new Date().toISOString();
    const existing = await this.contentProgress().findOne({ userId: input.user.id, contentId: input.content.id });
    const answers = input.answers ?? existing?.answers ?? {};
    const mechanicsState = input.mechanicsState ?? existing?.mechanicsState;
    const answeredQuestionIds = Object.keys(answers).filter((questionId) => answers[questionId] !== undefined);
    const progressPercent = input.progressPercent ?? deriveProgressPercent(answeredQuestionIds.length, input.content);
    const status = input.status ?? (progressPercent > 0 ? "in_progress" : "not_started");
    const progress: PactContentProgress = {
      id: existing?.id ?? crypto.randomUUID(),
      scope: existing?.scope ?? "user",
      courseId: input.user.courseId,
      cohortId: input.user.cohortId,
      squadId: input.user.squadId,
      userId: input.user.id,
      contentId: input.content.id,
      contentType: input.content.type,
      answers,
      mechanicsState,
      answeredQuestionIds,
      progressPercent,
      score: input.score ?? existing?.score,
      maxScore: input.maxScore ?? existing?.maxScore,
      status,
      startedAt: existing?.startedAt ?? input.startedAt ?? startedAtFromMechanicsState(mechanicsState),
      submittedAt: status === "submitted" ? (existing?.submittedAt ?? input.submittedAt ?? now) : existing?.submittedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.contentProgress().updateOne({ userId: input.user.id, contentId: input.content.id }, { $set: progress }, { upsert: true });
    return progress;
  }

  async upsertSquadContentProgress(input: {
    user: PactUser;
    content: PactContent;
    answers?: Record<string, PactAnswerValue>;
    mechanicsState?: PactMechanicsState;
    progressPercent?: number;
    status?: PactContentProgress["status"];
    startedAt?: string;
    submittedAt?: string;
    score?: number;
    maxScore?: number;
  }) {
    if (!input.user.squadId) {
      throw new AppError(409, "SQUAD_REQUIRED", "A squad assignment is required for squad progress");
    }
    const now = new Date().toISOString();
    const key = {
      scope: "squad" as const,
      courseId: input.user.courseId,
      cohortId: input.user.cohortId,
      squadId: input.user.squadId,
      contentId: input.content.id
    };
    const existing = await this.contentProgress().findOne(key);
    const answers = input.answers ?? existing?.answers ?? {};
    const mechanicsState = input.mechanicsState ?? existing?.mechanicsState;
    const answeredQuestionIds = Object.keys(answers).filter((questionId) => answers[questionId] !== undefined);
    const progressPercent = input.progressPercent ?? deriveProgressPercent(answeredQuestionIds.length, input.content);
    const status = input.status ?? (progressPercent > 0 ? "in_progress" : "not_started");
    const progress: PactContentProgress = {
      id: existing?.id ?? crypto.randomUUID(),
      scope: "squad",
      courseId: input.user.courseId,
      cohortId: input.user.cohortId,
      squadId: input.user.squadId,
      userId: squadProgressUserId(input.user.squadId),
      updatedByUserId: input.user.id,
      contentId: input.content.id,
      contentType: input.content.type,
      answers,
      mechanicsState,
      answeredQuestionIds,
      progressPercent,
      score: input.score ?? existing?.score,
      maxScore: input.maxScore ?? existing?.maxScore,
      status,
      startedAt: existing?.startedAt ?? input.startedAt ?? startedAtFromMechanicsState(mechanicsState),
      submittedAt: status === "submitted" ? (existing?.submittedAt ?? input.submittedAt ?? now) : existing?.submittedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.contentProgress().updateOne(key, { $set: progress }, { upsert: true });
    return progress;
  }

  async recordQuestionAttempt(input: {
    user: PactUser;
    content: PactContent;
    questionId: string;
    questionVersion?: number;
    answer: PactAnswerValue;
    score: number;
    maxScore: number;
    isCorrect: boolean;
    feedbackExposed: boolean;
  }) {
    const now = new Date().toISOString();
    const attemptNumber = await this.questionAttempts().countDocuments({
      userId: input.user.id,
      contentId: input.content.id,
      questionId: input.questionId
    }) + 1;
    const attempt: PactQuestionAttempt = {
      id: crypto.randomUUID(),
      courseId: input.user.courseId,
      cohortId: input.user.cohortId,
      squadId: input.user.squadId,
      userId: input.user.id,
      contentId: input.content.id,
      contentType: input.content.type,
      questionId: input.questionId,
      questionVersion: input.questionVersion,
      attemptNumber,
      answer: input.answer,
      score: input.score,
      maxScore: input.maxScore,
      isCorrect: input.isCorrect,
      feedbackExposed: input.feedbackExposed,
      feedbackExposedAt: input.feedbackExposed ? now : undefined,
      submittedAt: now,
      createdAt: now
    };
    await this.questionAttempts().insertOne(attempt);
    return attempt;
  }

  async countQuestionAttemptsForUserContentQuestion(input: { user: PactUser; content: PactContent; questionId: string }) {
    return this.questionAttempts().countDocuments({
      userId: input.user.id,
      contentId: input.content.id,
      questionId: input.questionId
    });
  }

  async countQuestionAttemptsForSquadContentQuestion(input: { user: PactUser; content: PactContent; questionId: string }) {
    if (!input.user.squadId) return 0;
    return this.questionAttempts().countDocuments({
      courseId: input.user.courseId,
      cohortId: input.user.cohortId,
      squadId: input.user.squadId,
      contentId: input.content.id,
      questionId: input.questionId
    });
  }

  async getQuestionAttemptForCourse(attemptId: string, courseId: string) {
    return this.questionAttempts().findOne({ id: attemptId, courseId });
  }

  async upsertQuestionGrade(input: {
    attempt: PactQuestionAttempt;
    score: number;
    maxScore: number;
    isCorrect: boolean;
    feedback?: string;
    gradedByUserId: string;
  }) {
    const now = new Date().toISOString();
    const existing = await this.questionGrades().findOne({ attemptId: input.attempt.id });
    const grade: PactQuestionGrade = {
      id: existing?.id ?? crypto.randomUUID(),
      courseId: input.attempt.courseId,
      cohortId: input.attempt.cohortId,
      squadId: input.attempt.squadId,
      userId: input.attempt.userId,
      contentId: input.attempt.contentId,
      questionId: input.attempt.questionId,
      attemptId: input.attempt.id,
      score: input.score,
      maxScore: input.maxScore,
      isCorrect: input.isCorrect,
      feedback: input.feedback,
      gradedByUserId: input.gradedByUserId,
      gradedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.questionGrades().updateOne({ attemptId: input.attempt.id }, { $set: grade }, { upsert: true });
    await this.auditEvents().insertOne({
      id: crypto.randomUUID(),
      action: "question.manual_grade.upserted",
      actorUserId: input.gradedByUserId,
      targetUserId: input.attempt.userId,
      courseId: input.attempt.courseId,
      cohortId: input.attempt.cohortId,
      metadata: {
        contentId: input.attempt.contentId,
        questionId: input.attempt.questionId,
        attemptId: input.attempt.id,
        previousScore: existing?.score,
        nextScore: input.score,
        maxScore: input.maxScore,
        previousIsCorrect: existing?.isCorrect,
        nextIsCorrect: input.isCorrect,
        feedbackChanged: existing?.feedback !== input.feedback
      },
      createdAt: now
    });
    return grade;
  }

  async listQuestionAttemptsForCohort(input: {
    session: { role: PactRole; courseId: string; cohortId: string };
    cohortId?: string;
    contentId?: string;
    userId?: string;
    questionId?: string;
    manualGradingStatus?: "pending" | "graded" | "not_required";
    limit: number;
  }) {
    const cohortId = input.cohortId ?? input.session.cohortId;
    const filter: Record<string, unknown> = { courseId: input.session.courseId, cohortId };
    if (input.contentId) filter.contentId = input.contentId;
    if (input.userId) filter.userId = input.userId;
    if (input.questionId) filter.questionId = input.questionId;

    const attempts = await this.questionAttempts()
      .find(filter)
      .sort({ submittedAt: -1 })
      .limit(input.manualGradingStatus ? 500 : input.limit)
      .toArray();
    const [users, content, grades] = await Promise.all([
      this.users()
        .find({ courseId: input.session.courseId, cohortId, id: { $in: Array.from(new Set(attempts.map((item) => item.userId))) } })
        .project<Pick<PactUser, "id" | "name" | "email" | "squadId">>({ _id: 0, id: 1, name: 1, email: 1, squadId: 1 })
        .toArray(),
      this.content()
        .find({ courseId: input.session.courseId, id: { $in: Array.from(new Set(attempts.map((item) => item.contentId))) } })
        .project<Pick<PactContent, "id" | "title" | "questions">>({ _id: 0, id: 1, title: 1, questions: 1 })
        .toArray(),
      this.questionGrades()
        .find({ attemptId: { $in: attempts.map((item) => item.id) } })
        .toArray()
    ]);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const contentById = new Map(content.map((item) => [item.id, item]));
    const gradesByAttemptId = new Map(grades.map((grade) => [grade.attemptId, grade]));

    const rows = attempts.map((attempt) => {
      const user = usersById.get(attempt.userId);
      const item = contentById.get(attempt.contentId);
      const question = item?.questions?.find((candidate) => candidate.id === attempt.questionId);
      const grade = gradesByAttemptId.get(attempt.id);
      const manualQuestion = question?.scoring.gradingMode === "manual";
      const manualGradingStatus = manualQuestion ? grade ? "graded" : "pending" : "not_required";
      return {
        id: attempt.id,
        courseId: attempt.courseId,
        cohortId: attempt.cohortId,
        squadId: attempt.squadId,
        userId: attempt.userId,
        learnerName: user?.name,
        learnerEmail: user?.email,
        contentId: attempt.contentId,
        contentTitle: item?.title,
        contentType: attempt.contentType,
        questionId: attempt.questionId,
        questionTopic: question?.topic,
        questionVersion: attempt.questionVersion,
        attemptNumber: attempt.attemptNumber,
        answer: attempt.answer,
        score: attempt.score,
        maxScore: attempt.maxScore,
        isCorrect: attempt.isCorrect,
        feedbackExposed: attempt.feedbackExposed,
        feedbackExposedAt: attempt.feedbackExposedAt,
        manualGradingStatus,
        manualGrade: grade ? {
          score: grade.score,
          maxScore: grade.maxScore,
          isCorrect: grade.isCorrect,
          feedback: grade.feedback,
          gradedByUserId: grade.gradedByUserId,
          gradedAt: grade.gradedAt
        } : undefined,
        submittedAt: attempt.submittedAt
      };
    });
    return rows
      .filter((attempt) => !input.manualGradingStatus || attempt.manualGradingStatus === input.manualGradingStatus)
      .slice(0, input.limit);
  }

  async listLatestQuestionAttemptsForUserContent(input: { user: PactUser; content: PactContent }) {
    const attempts = await this.questionAttempts()
      .find({
        userId: input.user.id,
        contentId: input.content.id,
        questionId: { $in: (input.content.questions ?? []).map((question) => question.id) }
      })
      .sort({ submittedAt: -1, attemptNumber: -1 })
      .toArray();
    const latestByQuestionId = new Map<string, PactQuestionAttempt>();
    for (const attempt of attempts) {
      if (!latestByQuestionId.has(attempt.questionId)) {
        latestByQuestionId.set(attempt.questionId, attempt);
      }
    }
    return latestByQuestionId;
  }

  async listLatestQuestionAttemptsForSquadContent(input: { user: PactUser; content: PactContent }) {
    if (!input.user.squadId) return new Map<string, PactQuestionAttempt>();
    const attempts = await this.questionAttempts()
      .find({
        courseId: input.user.courseId,
        cohortId: input.user.cohortId,
        squadId: input.user.squadId,
        contentId: input.content.id,
        questionId: { $in: (input.content.questions ?? []).map((question) => question.id) }
      })
      .sort({ submittedAt: -1, attemptNumber: -1 })
      .toArray();
    const latestByQuestionId = new Map<string, PactQuestionAttempt>();
    for (const attempt of attempts) {
      if (!latestByQuestionId.has(attempt.questionId)) {
        latestByQuestionId.set(attempt.questionId, attempt);
      }
    }
    return latestByQuestionId;
  }

  async listQuestionGradesForAttempts(attemptIds: string[]) {
    if (!attemptIds.length) return new Map<string, PactQuestionGrade>();
    const grades = await this.questionGrades()
      .find({ attemptId: { $in: attemptIds } })
      .toArray();
    return new Map(grades.map((grade) => [grade.attemptId, grade]));
  }

  async cohortProgressAnalytics(session: { role: PactRole; courseId: string; cohortId: string }, cohortId = session.cohortId) {
    const users = await this.users()
      .find({ courseId: session.courseId, cohortId, role: "learner" })
      .project<Pick<PactUser, "id" | "name" | "email" | "squadId">>({ _id: 0, id: 1, name: 1, email: 1, squadId: 1 })
      .sort({ name: 1, email: 1, id: 1 })
      .toArray();
    const [progressRecords, content, squads] = await Promise.all([
      this.contentProgress().find({
        courseId: session.courseId,
        cohortId,
        $or: [{ scope: "user" }, { scope: { $exists: false } }]
      }).toArray(),
      this.content().find({ courseId: session.courseId, $or: globalOrCohortFilter(cohortId) }).toArray(),
      this.squads().find({ courseId: session.courseId, cohortId }).toArray()
    ]);
    const progressByUser = groupBy(progressRecords, (item) => item.userId);
    const contentById = new Map(content.map((item) => [item.id, item]));
    const totalAssignedContent = content.length;
    const learnerSummaries = users.map((user) => {
      const records = progressByUser.get(user.id) ?? [];
      const submittedCount = records.filter((item) => item.status === "submitted").length;
      const averageProgressPercent = records.length
        ? Math.round(records.reduce((total, item) => total + item.progressPercent, 0) / records.length)
        : 0;
      const totalScore = records.reduce((total, item) => total + (item.score ?? 0), 0);
      const maxScore = records.reduce((total, item) => total + (item.maxScore ?? contentById.get(item.contentId)?.maxScore ?? 0), 0);

      return {
        userId: user.id,
        name: user.name,
        email: user.email,
        squadId: user.squadId,
        squadNumber: squadNumberForUser(user, squads),
        startedCount: records.length,
        submittedCount,
        assignedCount: totalAssignedContent,
        averageProgressPercent,
        totalScore,
        maxScore
      };
    });
    const submittedCount = progressRecords.filter((item) => item.status === "submitted").length;
    const averageProgressPercent = progressRecords.length
      ? Math.round(progressRecords.reduce((total, item) => total + item.progressPercent, 0) / progressRecords.length)
      : 0;

    return {
      courseId: session.courseId,
      cohortId,
      learnerCount: users.length,
      assignedContentCount: totalAssignedContent,
      startedContentCount: progressRecords.length,
      submittedContentCount: submittedCount,
      averageProgressPercent,
      learners: learnerSummaries
    };
  }

  async listGradeScores(courseId: string, cohortId?: string) {
    const scoreFilter: Record<string, string> = { courseId };
    if (cohortId) scoreFilter.cohortId = cohortId;
    const [scores, users, squads, content] = await Promise.all([
      this.scores().find(scoreFilter).toArray(),
      this.users().find({ courseId }).toArray(),
      this.squads().find({ courseId }).toArray(),
      this.content().find({ courseId }).toArray()
    ]);
    const userMap = new Map(users.map((user) => [user.id, user]));
    const contentMap = new Map(content.map((item) => [item.id, item]));
    return scores.map((score) => {
      const user = userMap.get(score.userId);
      const contentItem = contentMap.get(score.contentId);
      return {
        ...score,
        userName: user?.name,
        userEmail: user?.email,
        squadNumber: user ? squadNumberForUser(user, squads) : undefined,
        contentTitle: contentItem?.title,
        day: contentItem?.day
      };
    });
  }

  async listUsersForSquad(squadId: string, courseId: string) {
    return this.users().find({ squadId, courseId }).toArray();
  }

  async scoreboard(courseId: string, cohortId: string) {
    const match: Record<string, string> = { courseId, cohortId };
    const scores = await this.scores().find(match).toArray();
    const users = await this.users().find({ courseId, cohortId }).toArray();
    const squads = await this.squads().find({ courseId, cohortId }).toArray();
    return users.map((user) => {
      const userScores = scores.filter((score) => score.userId === user.id);
      const totalScore = userScores.reduce((total, score) => total + score.score, 0);
      const maxScore = userScores.reduce((total, score) => total + score.maxScore, 0);
      return {
        userId: user.id,
        name: user.name,
        role: user.role,
        squadId: user.squadId,
        squadNumber: squadNumberForUser(user, squads),
        totalScore,
        maxScore,
        progressPercent: userScores.length
          ? Math.round(userScores.reduce((total, score) => total + score.progressPercent, 0) / userScores.length)
          : 0
      };
    }).sort((a, b) => b.totalScore - a.totalScore);
  }

  private users() {
    return this.db.collection<PactUser>(collectionName(this.config, "pactUsers"));
  }

  private squads() {
    return this.db.collection<Squad>(collectionName(this.config, "pactSquads"));
  }

  private content() {
    return this.db.collection<PactContent>(collectionName(this.config, "pactContent"));
  }

  private scores() {
    return this.db.collection<PactScore>(collectionName(this.config, "pactScores"));
  }

  private contentProgress() {
    return this.db.collection<PactContentProgress>(collectionName(this.config, "pactContentProgress"));
  }

  private questionAttempts() {
    return this.db.collection<PactQuestionAttempt>(collectionName(this.config, "pactQuestionAttempts"));
  }

  private questionGrades() {
    return this.db.collection<PactQuestionGrade>(collectionName(this.config, "pactQuestionGrades"));
  }

  private auditEvents() {
    return this.db.collection<PactAuditEvent>(collectionName(this.config, "pactAuditEvents"));
  }

  async recordContentManualScoreAudit(input: { actorUserId: string; targetUserId: string; courseId: string; cohortId?: string; contentId: string; previousScore?: number; nextScore?: number; maxScore?: number }) {
    const now = new Date().toISOString();
    await this.auditEvents().insertOne({
      id: crypto.randomUUID(),
      action: "content.manual_score.upserted",
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      courseId: input.courseId,
      cohortId: input.cohortId ?? "",
      metadata: {
        contentId: input.contentId,
        previousScore: input.previousScore,
        nextScore: input.nextScore,
        maxScore: input.maxScore
      },
      createdAt: now
    });
  }

  private agsPublishAttempts() {
    return this.db.collection<PactAgsPublishAttempt>(collectionName(this.config, "pactAgsPublishAttempts"));
  }

  private agsContexts() {
    return this.db.collection<PactAgsContext>(collectionName(this.config, "pactAgsContexts"));
  }

  private notifications() {
    return this.db.collection<PactNotification>(collectionName(this.config, "pactNotifications"));
  }

  private bugReports() {
    return this.db.collection<PactBugReport>(collectionName(this.config, "pactBugReports"));
  }
}

function withoutCursor(filter: Record<string, unknown>) {
  const { createdAt: _createdAt, ...rest } = filter;
  return rest;
}

function deriveProgressPercent(answeredCount: number, content: PactContent) {
  const questionCount = content.questionCount ?? content.questions?.length ?? 0;
  return questionCount ? Math.min(100, Math.round((answeredCount / questionCount) * 100)) : 0;
}

function startedAtFromMechanicsState(mechanicsState: PactMechanicsState | undefined) {
  if (!mechanicsState) return undefined;
  const startedAt = mechanicsState.startedAt;
  if (typeof startedAt !== "string") return undefined;
  return Number.isFinite(Date.parse(startedAt)) ? startedAt : undefined;
}

function squadProgressUserId(squadId: string) {
  return `squad:${squadId}`;
}

function synthesisResponsesFromState(mechanicsState: PactMechanicsState | undefined): Record<string, string> {
  const value = mechanicsState?.synthesisResponses;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function isReviewableSubmissionContent(content: PactContent) {
  return (content.type === "challenge" && content.mechanics?.kind === "challenge_path") || content.type === "workshop";
}

function reviewPromptsForContent(content: PactContent, progress: PactContentProgress[] = []) {
  if (content.type === "challenge" && content.mechanics?.kind === "challenge_path") {
    return (content.mechanics.synthesisPrompts ?? []).map((prompt) => ({
      id: prompt.id,
      label: prompt.label,
      prompt: prompt.prompt,
      required: prompt.required !== false
    }));
  }
  if (content.type === "workshop") {
    if (content.questions?.length) {
      return content.questions.map((question) => ({
        id: question.id,
        label: question.topic || question.id,
        prompt: typeof question.stem?.prompt === "string" ? question.stem.prompt : question.topic || question.id,
        required: question.scoring?.optional !== true
      }));
    }
    return workshopPromptsFromProgress(progress);
  }
  return [];
}

function reviewResponsesForProgress(content: PactContent, progress: PactContentProgress | undefined): Record<string, string> {
  if (!progress) return {};
  if (content.type === "challenge" && content.mechanics?.kind === "challenge_path") {
    return synthesisResponsesFromState(progress.mechanicsState);
  }
  if (content.type !== "workshop") return {};
  const answers = progress.answers ?? {};
  const prompts = reviewPromptsForContent(content, [progress]);
  return Object.fromEntries(prompts.map((prompt) => [prompt.id, reviewAnswerToText(answers[prompt.id])]));
}

function workshopPromptsFromProgress(progress: PactContentProgress[]) {
  const answerIds = Array.from(new Set(progress.flatMap((item) => Object.keys(item.answers ?? {})))).sort();
  return answerIds.map((id) => ({
    id,
    label: id,
    prompt: id,
    required: true
  }));
}

function reviewAnswerToText(answer: PactAnswerValue | undefined) {
  if (answer === undefined) return "";
  if (typeof answer === "string") return answer;
  if (typeof answer === "boolean") return answer ? "true" : "false";
  if (Array.isArray(answer)) return answer.join(", ");
  return Object.entries(answer).map(([key, value]) => `${key}: ${value}`).join("\n");
}

function mechanicsMatchesContentType(type: ContentType, kind: ContentMechanics["kind"]) {
  if (type === "challenge") return kind === "challenge_path";
  if (type === "game") return kind === "packet_capture";
  if (type === "assessment") return kind === "readiness_checklist";
  return false;
}

function groupBy<T>(items: T[], keyFor: (item: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function globalOrCohortFilter(cohortId: string) {
  return [{ cohortId }, { cohortId: null }, { cohortId: { $exists: false } }];
}

function cohortMatches(contentCohortId: string | null | undefined, learnerCohortId: string) {
  return !contentCohortId || contentCohortId === learnerCohortId;
}

function normalizeContentDefaults(content: PactContent): PactContent {
  return {
    ...content,
    locked: content.locked ?? true
  };
}

function mechanicsUnlocksChallenge(mechanics: ContentMechanics | null) {
  return mechanics?.kind === "challenge_path" && (mechanics.releases ?? []).some((release) => release.unlocked);
}

function squadNumberFromName(name: string): SquadNumber | undefined {
  const match = /^Squad ([1-4])$/.exec(name);
  return match?.[1] as SquadNumber | undefined;
}

function squadNumberForUser(user: Pick<PactUser, "squadId">, squads: Squad[]) {
  const squad = squads.find((item) => item.id === user.squadId);
  return squad?.number ?? (squad ? squadNumberFromName(squad.name) : undefined);
}
