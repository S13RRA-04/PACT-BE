import type { Db } from "mongodb";
import type { AppConfig } from "../config/config.js";
import { collectionName } from "../db/mongo.js";
import { AppError } from "../errors/AppError.js";
import type { ContentStatus, ContentType, PactAnswerValue, PactAuditEvent, PactContent, PactContentProgress, PactQuestionAttempt, PactRole, PactScore, PactUser, Squad, SquadNumber } from "../domain/types.js";

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
    const cohortIds = Array.from(new Set([...users.map((user) => user.cohortId), ...squads.map((squad) => squad.cohortId)])).sort();

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

  async listAdminAuditEvents(session: { courseId: string }) {
    const events = await this.auditEvents()
      .find({ courseId: session.courseId, action: "squad.assignment.changed" })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    const userIds = Array.from(new Set(events.flatMap((event) => [event.actorUserId, event.targetUserId])));
    const users = await this.users()
      .find({ courseId: session.courseId, id: { $in: userIds } })
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
        previousSquadId: event.metadata.previousSquadId,
        nextSquadId: event.metadata.nextSquadId,
        nextSquadNumber: event.metadata.nextSquadNumber,
        createdAt: event.createdAt
      };
    });
  }

  async assignSquad(userId: string, squadId: string) {
    const user = await this.requireUser(userId);
    const squad = await this.squads().findOne({ id: squadId, courseId: user.courseId, cohortId: user.cohortId });
    if (!squad) throw new AppError(400, "INVALID_SQUAD_ASSIGNMENT", "Squad does not belong to the user's course and cohort");
    await this.users().updateOne({ id: userId }, { $set: { squadId, updatedAt: new Date().toISOString() } });
    return { ...user, squadId, updatedAt: new Date().toISOString() };
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
        nextSquadNumber: squad.number ?? squadNumberFromName(squad.name)
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

  async upsertContent(input: Omit<PactContent, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();
    const content: PactContent = { ...input, id, createdAt: now, updatedAt: now };
    await this.content().updateOne({ id }, { $set: content }, { upsert: true });
    return content;
  }

  async upsertContentForManagement(input: Omit<PactContent, "id" | "createdAt" | "updatedAt"> & { id?: string }, session: { role: PactRole; courseId: string; cohortId: string }) {
    if (input.courseId !== session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this course");
    }

    return this.upsertContent(input);
  }

  async listContentFor(user: PactUser, contentType?: ContentType) {
    if (user.role === "admin") {
      return this.content()
        .find({ courseId: user.courseId })
        .sort({ type: 1, title: 1 })
        .toArray();
    }

    if (user.role === "instructor") {
      return this.content()
        .find({ courseId: user.courseId })
        .sort({ type: 1, title: 1 })
        .toArray();
    }

    const typeFilter = contentType ? { type: contentType } : {};
    return this.content()
      .find({
        courseId: user.courseId,
        ...typeFilter,
        status: "published",
        role: { $in: [user.role, "all"] },
        $or: globalOrCohortFilter(user.cohortId)
      })
      .sort({ type: 1, title: 1 })
      .toArray();
  }

  async listContentForManagement(session: { role: PactRole; courseId: string; cohortId: string }) {
    const filter: Record<string, unknown> = { courseId: session.courseId };

    return this.content()
      .find(filter)
      .sort({ type: 1, title: 1 })
      .toArray();
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

  async countPublishedModulesForCourse(courseId: string) {
    return this.content().countDocuments({
      courseId,
      type: "module",
      status: "published"
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

  async listProgressForUser(user: PactUser, contentIds: string[]) {
    if (!contentIds.length) return [];
    return this.contentProgress()
      .find({ userId: user.id, courseId: user.courseId, cohortId: user.cohortId, contentId: { $in: contentIds } })
      .sort({ updatedAt: -1 })
      .toArray();
  }

  async upsertContentProgress(input: {
    user: PactUser;
    content: PactContent;
    answers?: Record<string, PactAnswerValue>;
    progressPercent?: number;
    status?: PactContentProgress["status"];
    score?: number;
    maxScore?: number;
  }) {
    const now = new Date().toISOString();
    const existing = await this.contentProgress().findOne({ userId: input.user.id, contentId: input.content.id });
    const answers = input.answers ?? existing?.answers ?? {};
    const answeredQuestionIds = Object.keys(answers).filter((questionId) => answers[questionId] !== undefined);
    const progressPercent = input.progressPercent ?? deriveProgressPercent(answeredQuestionIds.length, input.content);
    const status = input.status ?? (progressPercent > 0 ? "in_progress" : "not_started");
    const progress: PactContentProgress = {
      id: existing?.id ?? crypto.randomUUID(),
      courseId: input.user.courseId,
      cohortId: input.user.cohortId,
      squadId: input.user.squadId,
      userId: input.user.id,
      contentId: input.content.id,
      contentType: input.content.type,
      answers,
      answeredQuestionIds,
      progressPercent,
      score: input.score ?? existing?.score,
      maxScore: input.maxScore ?? existing?.maxScore,
      status,
      submittedAt: status === "submitted" ? (existing?.submittedAt ?? now) : existing?.submittedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.contentProgress().updateOne({ userId: input.user.id, contentId: input.content.id }, { $set: progress }, { upsert: true });
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

  async listQuestionAttemptsForCohort(input: {
    session: { role: PactRole; courseId: string; cohortId: string };
    cohortId?: string;
    contentId?: string;
    userId?: string;
    questionId?: string;
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
      .limit(input.limit)
      .toArray();
    const [users, content] = await Promise.all([
      this.users()
        .find({ courseId: input.session.courseId, cohortId, id: { $in: Array.from(new Set(attempts.map((item) => item.userId))) } })
        .project<Pick<PactUser, "id" | "name" | "email" | "squadId">>({ _id: 0, id: 1, name: 1, email: 1, squadId: 1 })
        .toArray(),
      this.content()
        .find({ courseId: input.session.courseId, id: { $in: Array.from(new Set(attempts.map((item) => item.contentId))) } })
        .project<Pick<PactContent, "id" | "title" | "questions">>({ _id: 0, id: 1, title: 1, questions: 1 })
        .toArray()
    ]);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const contentById = new Map(content.map((item) => [item.id, item]));

    return attempts.map((attempt) => {
      const user = usersById.get(attempt.userId);
      const item = contentById.get(attempt.contentId);
      const question = item?.questions?.find((candidate) => candidate.id === attempt.questionId);
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
        submittedAt: attempt.submittedAt
      };
    });
  }

  async cohortProgressAnalytics(session: { role: PactRole; courseId: string; cohortId: string }, cohortId = session.cohortId) {
    const users = await this.users()
      .find({ courseId: session.courseId, cohortId, role: "learner" })
      .project<Pick<PactUser, "id" | "name" | "email" | "squadId">>({ _id: 0, id: 1, name: 1, email: 1, squadId: 1 })
      .sort({ name: 1, email: 1, id: 1 })
      .toArray();
    const [progressRecords, content, squads] = await Promise.all([
      this.contentProgress().find({ courseId: session.courseId, cohortId }).toArray(),
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

  async scoreboard(courseId: string, cohortId: string, squadId?: string) {
    const match: Record<string, string> = { courseId, cohortId };
    if (squadId) match.squadId = squadId;
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

  private auditEvents() {
    return this.db.collection<PactAuditEvent>(collectionName(this.config, "pactAuditEvents"));
  }
}

function deriveProgressPercent(answeredCount: number, content: PactContent) {
  const questionCount = content.questionCount ?? content.questions?.length ?? 0;
  return questionCount ? Math.min(100, Math.round((answeredCount / questionCount) * 100)) : 0;
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

function squadNumberFromName(name: string): SquadNumber | undefined {
  const match = /^Squad ([1-4])$/.exec(name);
  return match?.[1] as SquadNumber | undefined;
}

function squadNumberForUser(user: Pick<PactUser, "squadId">, squads: Squad[]) {
  const squad = squads.find((item) => item.id === user.squadId);
  return squad?.number ?? (squad ? squadNumberFromName(squad.name) : undefined);
}
