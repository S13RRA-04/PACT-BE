import type { Db } from "mongodb";
import type { AppConfig } from "../config/config.js";
import { collectionName } from "../db/mongo.js";
import { AppError } from "../errors/AppError.js";
import type { ContentStatus, ContentType, PactContent, PactRole, PactScore, PactUser, Squad } from "../domain/types.js";

export class PactRepository {
  constructor(private readonly db: Db, private readonly config: AppConfig) {}

  async upsertUser(input: Omit<PactUser, "id" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    const existing = await this.users().findOne({ lmsUserId: input.lmsUserId });
    const user: PactUser = {
      id: existing?.id ?? crypto.randomUUID(),
      ...input,
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

  async createSquad(input: { courseId: string; cohortId: string; name: string }) {
    const now = new Date().toISOString();
    const existing = await this.squads().findOne(input);
    if (existing) return existing;
    const squad: Squad = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
    await this.squads().insertOne(squad);
    return squad;
  }

  async assignSquad(userId: string, squadId: string) {
    const user = await this.requireUser(userId);
    const squad = await this.squads().findOne({ id: squadId, courseId: user.courseId, cohortId: user.cohortId });
    if (!squad) throw new AppError(400, "INVALID_SQUAD_ASSIGNMENT", "Squad does not belong to the user's course and cohort");
    await this.users().updateOne({ id: userId }, { $set: { squadId, updatedAt: new Date().toISOString() } });
    return { ...user, squadId, updatedAt: new Date().toISOString() };
  }

  async upsertContent(input: Omit<PactContent, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();
    const content: PactContent = { ...input, id, createdAt: now, updatedAt: now };
    await this.content().updateOne({ id }, { $set: content }, { upsert: true });
    return content;
  }

  async listContentFor(user: PactUser) {
    if (user.role === "admin") {
      return this.content()
        .find({ courseId: user.courseId })
        .sort({ type: 1, title: 1 })
        .toArray();
    }

    if (user.role === "instructor") {
      return this.content()
        .find({
          courseId: user.courseId,
          $or: [{ cohortId: user.cohortId }, { cohortId: { $exists: false } }]
        })
        .sort({ type: 1, title: 1 })
        .toArray();
    }

    return this.content()
      .find({
        courseId: user.courseId,
        status: "published",
        role: { $in: [user.role, "all"] },
        $or: [{ cohortId: user.cohortId }, { cohortId: { $exists: false } }]
      })
      .sort({ type: 1, title: 1 })
      .toArray();
  }

  async listContentForManagement(session: { role: PactRole; courseId: string; cohortId: string }) {
    const filter: Record<string, unknown> = { courseId: session.courseId };
    if (session.role === "instructor") {
      filter.$or = [{ cohortId: session.cohortId }, { cohortId: { $exists: false } }];
    }

    return this.content()
      .find(filter)
      .sort({ type: 1, title: 1 })
      .toArray();
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
    if (input.session.role === "instructor" && content.cohortId && content.cohortId !== input.session.cohortId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is not assigned to this cohort");
    }

    const updatedAt = new Date().toISOString();
    await this.content().updateOne({ id: input.contentId }, { $set: { status: input.status, updatedAt } });
    return { ...content, status: input.status, updatedAt };
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

  async scoreboard(courseId: string, cohortId: string, squadId?: string) {
    const match: Record<string, string> = { courseId, cohortId };
    if (squadId) match.squadId = squadId;
    const scores = await this.scores().find(match).toArray();
    const users = await this.users().find({ courseId, cohortId }).toArray();
    return users.map((user) => {
      const userScores = scores.filter((score) => score.userId === user.id);
      const totalScore = userScores.reduce((total, score) => total + score.score, 0);
      const maxScore = userScores.reduce((total, score) => total + score.maxScore, 0);
      return {
        userId: user.id,
        name: user.name,
        role: user.role,
        squadId: user.squadId,
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
}
