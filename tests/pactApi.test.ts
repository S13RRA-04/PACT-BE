import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config/config.js";
import { ensureMongoCollections, getMongoDb } from "../src/db/mongo.js";
import { SessionService } from "../src/auth/sessionService.js";
import { createLogger } from "../src/logging/logger.js";

let mongo: MongoMemoryServer;
let config: AppConfig;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  config = {
    env: "test",
    port: 4100,
    appBaseUrl: "http://localhost:4100",
    mongoUri: mongo.getUri(),
    mongoDbName: "PACT_TEST",
    mongoCollectionPrefix: "test_",
    lmsApiBaseUrl: "http://lms.example.test",
    lmsPlatformIssuer: "http://lms.example.test",
    lmsPlatformJwksUri: "http://lms.example.test/jwks",
    pactLtiClientId: "pact-tool",
    pactLtiDeploymentIds: ["deployment-1"],
    pactSessionSecret: "test-secret-with-enough-length",
    corsOrigins: []
  };
  await ensureMongoCollections(config);
});

afterAll(async () => {
  await mongo.stop();
});

describe("PACT API", () => {
  it("serves role and cohort scoped content", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactUsers").insertOne({
      id: "user-1",
      lmsUserId: "lms-user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await db.collection("test_pactContent").insertMany([
      publishedContent("content-1", "cohort-a", "learner"),
      publishedContent("content-2", "cohort-b", "learner"),
      publishedContent("content-3", "cohort-a", "admin")
    ]);

    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0].id).toBe("content-1");
  });

  it("records scores and returns scoreboard entries", async () => {
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/scores")
      .set("authorization", `Bearer ${token}`)
      .send({ contentId: "content-1", score: 8, maxScore: 10, progressPercent: 100 })
      .expect(201);

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/dashboard/scoreboard")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.entries[0]).toMatchObject({ userId: "user-1", totalScore: 8, maxScore: 10, progressPercent: 100 });
  });
});

function publishedContent(id: string, cohortId: string, role: "learner" | "admin") {
  const now = new Date().toISOString();
  return {
    id,
    courseId: "pact",
    cohortId,
    role,
    type: "module",
    title: id,
    prompt: "Answer the prompt",
    maxScore: 10,
    status: "published",
    createdAt: now,
    updatedAt: now
  };
}
