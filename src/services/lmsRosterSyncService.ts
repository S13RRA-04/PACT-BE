import type { Db } from "mongodb";
import type { AppConfig } from "../config/config.js";
import { getMongoDatabase } from "../db/mongo.js";
import type { PactRole } from "../domain/types.js";
import { PactRepository } from "../repositories/pactRepository.js";

type LmsEnrollment = {
  id: string;
  userId: string;
  courseId: string;
  cohortId?: string;
  status: string;
};

type LmsUser = {
  id: string;
  email?: string;
  name?: string;
  role?: string;
  enabled?: boolean;
  deletedAt?: string;
};

export class LmsRosterSyncService {
  constructor(
    private readonly config: AppConfig,
    private readonly pactRepository: PactRepository
  ) {}

  async syncCourseRoster(courseId: string) {
    const lmsDb = await getMongoDatabase(this.config, this.config.lmsMongoDbName);
    const enrollments = await this.listActiveEnrollments(lmsDb, courseId);
    const userIds = Array.from(new Set(enrollments.map((enrollment) => enrollment.userId)));
    const users = await this.listLmsUsers(lmsDb, userIds);
    const usersById = new Map(users.map((user) => [user.id, user]));
    let imported = 0;
    let skipped = 0;

    for (const enrollment of enrollments) {
      const user = usersById.get(enrollment.userId);
      if (!user || !enrollment.cohortId) {
        skipped += 1;
        continue;
      }

      await this.pactRepository.upsertUser({
        lmsUserId: user.id,
        email: user.email,
        name: user.name,
        role: lmsRoleToPactRole(user.role),
        courseId: enrollment.courseId,
        cohortId: enrollment.cohortId
      });
      imported += 1;
    }

    return {
      scanned: enrollments.length,
      imported,
      skipped,
      lmsDbName: this.config.lmsMongoDbName
    };
  }

  private async listActiveEnrollments(db: Db, courseId: string) {
    return db.collection<LmsEnrollment>(lmsCollectionName(this.config, "enrollments"))
      .find({
        courseId,
        status: { $nin: ["expired", "failed"] },
        cohortId: { $type: "string", $ne: "" }
      })
      .project<LmsEnrollment>({ _id: 0, id: 1, userId: 1, courseId: 1, cohortId: 1, status: 1 })
      .toArray();
  }

  private async listLmsUsers(db: Db, userIds: string[]) {
    if (!userIds.length) return [];
    return db.collection<LmsUser>(lmsCollectionName(this.config, "users"))
      .find({
        id: { $in: userIds },
        enabled: { $ne: false },
        deletedAt: { $exists: false }
      })
      .project<LmsUser>({ _id: 0, id: 1, email: 1, name: 1, role: 1, enabled: 1, deletedAt: 1 })
      .toArray();
  }
}

function lmsCollectionName(config: AppConfig, name: string) {
  return `${config.lmsMongoCollectionPrefix}${name}`;
}

function lmsRoleToPactRole(role: string | undefined): PactRole {
  if (role === "admin" || role === "instructor") return role;
  return "learner";
}
