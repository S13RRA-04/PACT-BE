import http from "node:http";
import { createHmac } from "node:crypto";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config/config.js";
import { ensureMongoCollections, getMongoDb } from "../src/db/mongo.js";
import { SessionService } from "../src/auth/sessionService.js";
import { createLogger } from "../src/logging/logger.js";
import { pactSessionCookieName } from "../src/middleware/currentSession.js";
import { PactRepository } from "../src/repositories/pactRepository.js";
import { AgsMaintenanceService } from "../src/services/agsMaintenanceService.js";
import { PactService } from "../src/services/pactService.js";
import { LmsAgsClient } from "../src/integrations/lmsAgsClient.js";
import { LmsTokenClient } from "../src/integrations/lmsTokenClient.js";

let mongo: MongoMemoryServer;
let jwksServer: http.Server;
let platformPrivateKey: KeyLike;
let config: AppConfig;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const platformKeys = await generateKeyPair("RS256");
  platformPrivateKey = platformKeys.privateKey;
  const platformPublicJwk = await exportJWK(platformKeys.publicKey);
  const jwks = { keys: [{ ...platformPublicJwk, kid: "platform-key", alg: "RS256", use: "sig" }] };
  jwksServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const address = jwksServer.address();
  if (typeof address !== "object" || !address) throw new Error("JWKS server did not start");
  const pactKeys = await generateKeyPair("RS256");
  config = {
    env: "test",
    port: 4100,
    appBaseUrl: "http://localhost:4100",
    pactWebBaseUrl: "http://pact.example.test",
    mongoUri: mongo.getUri(),
    mongoDbName: "PACT_TEST",
    mongoCollectionPrefix: "test_",
    lmsApiBaseUrl: "http://lms.example.test",
    lmsPlatformIssuer: "http://lms.example.test",
    lmsPlatformJwksUri: `http://127.0.0.1:${address.port}/jwks`,
    lmsDeepLinkReturnUrl: "http://lms.example.test/api/v1/lti/deep-linking/return",
    lmsMongoDbName: "LMS_TEST",
    lmsMongoCollectionPrefix: "lms_test_",
    pactLtiClientId: "pact-tool",
    pactLtiDeploymentIds: ["deployment-1"],
    pactSessionSecret: "test-secret-with-enough-length",
    pactToolKid: "pact-key",
    pactToolPrivateKeyPem: await exportPKCS8(pactKeys.privateKey),
    pactAllowLegacyLtiPaths: true,
    corsOrigins: [],
    agsAutoRetryEnabled: false,
    agsAutoRetryMaxAttempts: 3,
    agsAutoRetryInitialDelayMs: 30000,
    agsAutoRetryMaxDelayMs: 300000,
    agsAttemptRetentionDays: 90,
    agsRetentionCleanupIntervalMs: 86400000,
    agsRetryExhaustedWebhookUrls: [],
    agsRetryExhaustedWebhookBearerToken: undefined,
    agsRetryExhaustedWebhookMaxAttempts: 5,
    agsRetryExhaustedWebhookInitialDelayMs: 60000,
    agsRetryExhaustedWebhookMaxDelayMs: 3600000,
    linearBugSyncEnabled: false
  };
  await ensureMongoCollections(config);
});

afterAll(async () => {
  await mongo.stop();
  await new Promise<void>((resolve, reject) => jwksServer.close((error) => (error ? reject(error) : resolve())));
});

describe("PACT API", () => {
  it("serves role and cohort scoped content to learners", async () => {
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
      publishedContent("content-3", "cohort-a", "admin"),
      publishedContent("content-global", null, "learner")
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

    expect(response.body.map((item: { id: string }) => item.id)).toEqual(["content-1", "content-global"]);
  });

  it("serves only unlocked challenge releases and release questions to learners", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactUsers").insertOne({
      id: "release-learner",
      lmsUserId: "lms-release-learner",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-release",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("release-challenge", "cohort-release", "learner", "published", "challenge", false),
      mechanics: {
        kind: "challenge_path",
        title: "Release challenge",
        prompt: "Review released evidence.",
        releases: [
          {
            id: "release-1",
            title: "Initial release",
            summary: "Unlocked files.",
            unlocked: true,
            files: [{ key: "challenges/release-1/brief.pdf", title: "Brief" }],
            questionIds: ["release-q1"]
          },
          {
            id: "release-2",
            title: "Locked release",
            summary: "Not yet available.",
            unlocked: false,
            files: [{ key: "challenges/release-2/edr.pdf", title: "EDR" }],
            questionIds: ["release-q2"]
          }
        ],
        paths: [{ id: "develop", label: "Develop", detail: "Build the case.", score: 100 }]
      },
      questions: [
        { ...policyQuestion("release-q1", { kind: "true_false", correct: true }, { points: 5 }), releaseId: "release-1" },
        { ...policyQuestion("release-q2", { kind: "true_false", correct: true }, { points: 5 }), releaseId: "release-2" }
      ]
    });

    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "release-learner",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-release"
    });
    const r2Config = {
      ...config,
      r2AccountId: "test-account",
      r2AccessKeyId: "test-access",
      r2SecretAccessKey: "test-secret",
      r2BucketName: "pact"
    };

    const response = await request(createApp(r2Config, createLogger(r2Config)))
      .get("/api/v1/content")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    const challenge = response.body.find((item: { id: string }) => item.id === "release-challenge");
    expect(challenge.mechanics.releases).toHaveLength(1);
    expect(challenge.mechanics.releases[0]).toMatchObject({ id: "release-1" });
    expect(challenge.mechanics.releases[0].files[0].viewUrl).toContain("X-Amz-Signature=");
    expect(JSON.stringify(challenge)).not.toContain("release-2");
    expect(challenge.questions.map((question: { id: string }) => question.id)).toEqual(["release-q1"]);

    await request(createApp(r2Config, createLogger(r2Config)))
      .post("/api/v1/content/release-challenge/questions/release-q2/attempts")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: true, feedbackExposed: true })
      .expect(404);
  });

  it("requires instructor unlock before learners can see or access published content", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactUsers").updateOne(
      { id: "locked-learner" },
      {
        $set: {
          id: "locked-learner",
          lmsUserId: "lms-locked-learner",
          role: "learner",
          courseId: "pact-lock",
          cohortId: "cohort-lock",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    await db.collection("test_pactUsers").updateOne(
      { id: "lock-instructor" },
      {
        $set: {
          id: "lock-instructor",
          lmsUserId: "lms-lock-instructor",
          role: "instructor",
          courseId: "pact-lock",
          cohortId: "cohort-lock",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    const lockedDefaultContent = { ...publishedContent("locked-default-content", "cohort-lock", "learner", "published", "module"), courseId: "pact-lock" };
    delete (lockedDefaultContent as { locked?: boolean }).locked;
    await db.collection("test_pactContent").insertMany([
      lockedDefaultContent,
      { ...publishedContent("locked-explicit-content", "cohort-lock", "learner", "published", "challenge", true), courseId: "pact-lock" },
      { ...publishedContent("unlocked-content", "cohort-lock", "learner", "published", "assessment", false), courseId: "pact-lock" }
    ]);

    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "locked-learner",
      role: "learner",
      courseId: "pact-lock",
      cohortId: "cohort-lock"
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "lock-instructor",
      role: "instructor",
      courseId: "pact-lock",
      cohortId: "cohort-lock"
    });

    const initialResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(200);
    expect(initialResponse.body.map((item: { id: string }) => item.id)).toEqual(["unlocked-content"]);

    const diagnosticResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/diagnostics/content-access")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);
    expect(diagnosticResponse.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contentId: "locked-default-content",
        learnerVisible: false,
        blockers: expect.arrayContaining(["unlocked"])
      }),
      expect.objectContaining({
        contentId: "locked-explicit-content",
        learnerVisible: false,
        blockers: expect.arrayContaining(["unlocked"])
      }),
      expect.objectContaining({
        contentId: "unlocked-content",
        learnerVisible: true,
        blockers: []
      })
    ]));

    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/content/locked-explicit-content/progress")
      .set("authorization", `Bearer ${learnerToken}`)
      .send({ progressPercent: 25 })
      .expect(403)
      .expect((response) => {
        expect(response.body.error).toMatchObject({ code: "CONTENT_LOCKED" });
      });

    await request(createApp(config, createLogger(config)))
      .get("/api/v1/content/locked-default-content/completion")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(403)
      .expect((response) => {
        expect(response.body.error).toMatchObject({ code: "CONTENT_LOCKED" });
      });

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/scores")
      .set("authorization", `Bearer ${learnerToken}`)
      .send({ contentId: "locked-explicit-content", score: 1, maxScore: 10, progressPercent: 100 })
      .expect(403)
      .expect((response) => {
        expect(response.body.error).toMatchObject({ code: "CONTENT_LOCKED" });
      });

    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/content/locked-explicit-content/lock")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ locked: false })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ id: "locked-explicit-content", locked: false });
      });

    const unlockedResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(200);
    expect(unlockedResponse.body.map((item: { id: string }) => item.id).sort()).toEqual(["locked-explicit-content", "unlocked-content"]);

    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/content/locked-explicit-content/progress")
      .set("authorization", `Bearer ${learnerToken}`)
      .send({ progressPercent: 25 })
      .expect(200);
  });

  it("syncs active LMS enrollments into PACT admin cohorts before learners launch", async () => {
    const pactDb = await getMongoDb(config);
    const mongoClient = await new MongoClient(config.mongoUri).connect();
    const externalLmsDb = mongoClient.db(config.lmsMongoDbName);
    const now = new Date().toISOString();

    await pactDb.collection("test_pactUsers").updateOne(
      { id: "roster-admin" },
      {
        $set: {
          id: "roster-admin",
          lmsUserId: "lms-roster-admin",
          role: "admin",
          courseId: "pact-roster",
          cohortId: "cohort-roster",
          createdAt: now,
          updatedAt: now
        }
      },
      { upsert: true }
    );
    await externalLmsDb.collection("lms_test_users").insertMany([
      { id: "lms-learner-a", email: "learner-a@example.test", name: "Learner A", role: "learner", enabled: true, createdAt: now, updatedAt: now },
      { id: "lms-learner-b", email: "learner-b@example.test", name: "Learner B", role: "learner", enabled: true, createdAt: now, updatedAt: now },
      { id: "disabled-learner", email: "disabled@example.test", name: "Disabled", role: "learner", enabled: false, createdAt: now, updatedAt: now }
    ]);
    await externalLmsDb.collection("lms_test_enrollments").insertMany([
      { id: "enrollment-a", userId: "lms-learner-a", courseId: "pact-roster", cohortId: "cohort-roster", status: "not_started", enrolledAt: now },
      { id: "enrollment-b", userId: "lms-learner-b", courseId: "pact-roster", cohortId: "cohort-roster", status: "in_progress", enrolledAt: now },
      { id: "enrollment-disabled", userId: "disabled-learner", courseId: "pact-roster", cohortId: "cohort-roster", status: "not_started", enrolledAt: now },
      { id: "enrollment-expired", userId: "lms-expired", courseId: "pact-roster", cohortId: "cohort-roster", status: "expired", enrolledAt: now }
    ]);

    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "roster-admin",
      role: "admin",
      courseId: "pact-roster",
      cohortId: "cohort-roster"
    });

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/cohorts")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    const cohort = response.body.cohorts.find((item: { cohortId: string }) => item.cohortId === "cohort-roster");
    expect(cohort.users.map((user: { email?: string }) => user.email)).toEqual(expect.arrayContaining([
      "learner-a@example.test",
      "learner-b@example.test"
    ]));
    expect(cohort.users.map((user: { email?: string }) => user.email)).not.toContain("disabled@example.test");

    await mongoClient.close();
  });

  it("returns challenge synthesis submissions grouped by squad for instructors", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "submission-instructor",
        lmsUserId: "lms-submission-instructor",
        role: "instructor",
        courseId: "pact-submissions",
        cohortId: "cohort-submissions",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "submission-learner",
        lmsUserId: "lms-submission-learner",
        email: "learner@example.test",
        name: "Submission Learner",
        role: "learner",
        courseId: "pact-submissions",
        cohortId: "cohort-submissions",
        squadId: "submission-squad-1",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactSquads").insertOne({
      id: "submission-squad-1",
      courseId: "pact-submissions",
      cohortId: "cohort-submissions",
      name: "Squad 1",
      number: "1",
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("workshop-submissions", "cohort-submissions", "learner", "published", "challenge", false),
      courseId: "pact-submissions",
      mechanics: {
        kind: "challenge_path",
        title: "Workshop",
        prompt: "Capture synthesis.",
        synthesisPrompts: [
          { id: "agent", label: "Agent response", prompt: "Agent prompt" },
          { id: "analyst", label: "Analyst response", prompt: "Analyst prompt" }
        ],
        paths: [{ id: "complete", label: "Complete", detail: "Complete prompts.", score: 100 }]
      }
    });
    await db.collection("test_pactContentProgress").insertOne({
      id: "submission-progress",
      courseId: "pact-submissions",
      cohortId: "cohort-submissions",
      squadId: "submission-squad-1",
      userId: "submission-learner",
      contentId: "workshop-submissions",
      contentType: "challenge",
      answers: {},
      mechanicsState: {
        kind: "challenge_path",
        synthesisResponses: {
          agent: "Agent response text"
        }
      },
      answeredQuestionIds: [],
      progressPercent: 50,
      status: "in_progress",
      createdAt: now,
      updatedAt: now
    });

    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "submission-instructor",
      role: "instructor",
      courseId: "pact-submissions",
      cohortId: "cohort-submissions"
    });

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/content/workshop-submissions/submissions")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.content).toMatchObject({ id: "workshop-submissions", title: "workshop-submissions" });
    expect(response.body.squads[0]).toMatchObject({ key: "1", label: "Squad 1" });
    expect(response.body.squads[0].submissions[0]).toMatchObject({
      learnerName: "Submission Learner",
      completedPromptIds: ["agent"],
      progressPercent: 50
    });
    expect(response.body.squads[0].submissions[0].responses[0]).toMatchObject({
      promptId: "agent",
      response: "Agent response text"
    });
  });

  it("locks all published course content for a one-time admin reset", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertOne({
      id: "bulk-lock-admin",
      lmsUserId: "lms-bulk-lock-admin",
      role: "admin",
      courseId: "pact-bulk-lock",
      cohortId: "cohort-bulk-lock",
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactContent").insertMany([
      { ...publishedContent("bulk-published-one", "cohort-bulk-lock", "learner", "published", "module", false), courseId: "pact-bulk-lock" },
      { ...publishedContent("bulk-published-two", "cohort-bulk-lock", "learner", "published", "assessment", false), courseId: "pact-bulk-lock" },
      { ...publishedContent("bulk-draft", "cohort-bulk-lock", "learner", "draft", "module", false), courseId: "pact-bulk-lock" },
      { ...publishedContent("bulk-other-course", "cohort-bulk-lock", "learner", "published", "module", false), courseId: "pact-other-course" }
    ]);
    const adminToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "bulk-lock-admin",
      role: "admin",
      courseId: "pact-bulk-lock",
      cohortId: "cohort-bulk-lock"
    });

    const response = await request(createApp(config, createLogger(config)))
      .post("/api/v1/admin/content/lock-published")
      .set("authorization", `Bearer ${adminToken}`)
      .send({})
      .expect(200);

    expect(response.body).toMatchObject({ matched: 2, modified: 2 });
    const content = await db.collection("test_pactContent").find({ id: /^bulk-/ }).sort({ id: 1 }).toArray();
    expect(content.find((item) => item.id === "bulk-published-one")?.locked).toBe(true);
    expect(content.find((item) => item.id === "bulk-published-two")?.locked).toBe(true);
    expect(content.find((item) => item.id === "bulk-draft")?.locked).toBe(false);
    expect(content.find((item) => item.id === "bulk-other-course")?.locked).toBe(false);
  });

  it("does not hide unlocked learner content from other types during a typed launch", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactUsers").updateOne(
      { id: "module-scoped-user" },
      {
        $set: {
          id: "module-scoped-user",
          lmsUserId: "lms-module-scoped-user",
          role: "learner",
          courseId: "pact",
          cohortId: "cohort-module-scoped",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    await db.collection("test_pactContent").insertMany([
      publishedContent("module-scoped-module", "cohort-module-scoped", "learner", "published", "module"),
      publishedContent("module-scoped-challenge", "cohort-module-scoped", "learner", "published", "challenge")
    ]);

    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "module-scoped-user",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-module-scoped",
      contentType: "module"
    });

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    const contentIds = response.body.map((item: { id: string }) => item.id);
    expect(contentIds).toContain("module-scoped-module");
    expect(contentIds).toContain("module-scoped-challenge");
  });

  it("does not content-type scope instructor review sessions", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactUsers").updateOne(
      { id: "instructor-type-scope" },
      {
        $set: {
          id: "instructor-type-scope",
          lmsUserId: "lms-instructor-type-scope",
          role: "instructor",
          courseId: "pact",
          cohortId: "cohort-type-scope",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    await db.collection("test_pactContent").insertMany([
      publishedContent("instructor-type-module", "cohort-type-scope", "learner", "draft", "module"),
      publishedContent("instructor-type-challenge", "cohort-type-scope", "learner", "draft", "challenge")
    ]);

    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "instructor-type-scope",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-type-scope",
      contentType: "module"
    });

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    const contentIds = response.body.map((item: { id: string }) => item.id);
    expect(contentIds).toEqual(expect.arrayContaining(["instructor-type-module", "instructor-type-challenge"]));
  });

  it("rejects unsupported LTI launch content types", async () => {
    const idToken = await signResourceLaunch();

    await request(createApp(config, createLogger(config)))
      .post("/launch/video")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: idToken })
      .expect(400);
  });

  it("serves all scoped content to admins and instructors for review", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactUsers").updateOne(
      { id: "admin-visible" },
      {
        $set: {
          id: "admin-visible",
          lmsUserId: "lms-admin-visible",
          role: "admin",
          courseId: "pact",
          cohortId: "cohort-a",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    await db.collection("test_pactUsers").updateOne(
      { id: "instructor-visible" },
      {
        $set: {
          id: "instructor-visible",
          lmsUserId: "lms-instructor-visible",
          role: "instructor",
          courseId: "pact",
          cohortId: "cohort-a",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    await db.collection("test_pactContent").insertMany([
      publishedContent("admin-visible-draft", "cohort-a", "learner", "draft"),
      publishedContent("admin-visible-assessment", "cohort-a", "learner", "published", "assessment"),
      publishedContent("admin-visible-other-cohort", "cohort-b", "learner", "draft"),
      publishedContent("admin-visible-global", null, "learner", "draft")
    ]);
    await db.collection("test_pactContent").updateOne({ id: "admin-visible-draft" }, { $unset: { locked: "" } });

    const adminToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "admin-visible",
      role: "admin",
      courseId: "pact",
      cohortId: "cohort-a"
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "instructor-visible",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-a"
    });

    const adminResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    const instructorResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);

    expect(adminResponse.body.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([
      "admin-visible-draft",
      "admin-visible-assessment",
      "admin-visible-other-cohort"
    ]));
    expect(instructorResponse.body.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([
      "admin-visible-draft",
      "admin-visible-assessment",
      "admin-visible-other-cohort",
      "admin-visible-global"
    ]));
    expect(adminResponse.body.find((item: { id: string }) => item.id === "admin-visible-draft")).toMatchObject({
      id: "admin-visible-draft",
      locked: true
    });
  });

  it("returns admin-only session diagnostics with visible content count", async () => {
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "instructor-visible",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-a"
    });
    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });

    await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/diagnostics/session")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(403);

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/diagnostics/session")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);

    expect(response.body).toMatchObject({
      courseId: "pact",
      cohortId: "cohort-a",
      role: "instructor"
    });
    expect(response.body.visibleContentCount).toBeGreaterThan(0);
    expect(response.body.contentCounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        courseId: "pact",
        cohortId: "cohort-a",
        type: "module",
        status: "draft"
      })
    ]));
    expect(response.body.publishedModuleWarning).toBeUndefined();
  });

  it("returns content diagnostics counts and warns when a launched course has no published modules", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactUsers").insertOne({
      id: "no-module-admin",
      lmsUserId: "lms-no-module-admin",
      role: "admin",
      courseId: "course-no-modules",
      cohortId: "cohort-no-modules",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await db.collection("test_pactContent").insertMany([
      publishedContent("no-module-draft-module", "cohort-no-modules", "learner", "draft"),
      publishedContent("no-module-published-challenge", "cohort-no-modules", "learner", "published", "challenge")
    ].map((item) => ({ ...item, courseId: "course-no-modules" })));

    const adminToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "no-module-admin",
      role: "admin",
      courseId: "course-no-modules",
      cohortId: "cohort-no-modules"
    });

    const diagnostics = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/diagnostics/session")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    const counts = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/diagnostics/content-counts")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(diagnostics.body.publishedModuleWarning).toMatchObject({
      code: "NO_PUBLISHED_MODULES"
    });
    expect(counts.body.counts).toEqual(expect.arrayContaining([
      expect.objectContaining({ courseId: "course-no-modules", cohortId: "cohort-no-modules", type: "module", status: "draft", count: 1 }),
      expect.objectContaining({ courseId: "course-no-modules", cohortId: "cohort-no-modules", type: "challenge", status: "published", count: 1 })
    ]));
  });

  it("lets admins view cohorts and assign learners to numbered squads", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "admin-console-admin",
        lmsUserId: "lms-admin-console-admin",
        role: "admin",
        courseId: "pact-console",
        cohortId: "cohort-console-a",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "admin-console-learner",
        lmsUserId: "lms-admin-console-learner",
        email: "learner.console@example.test",
        name: "Console Learner",
        role: "learner",
        courseId: "pact-console",
        cohortId: "cohort-console-a",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "admin-console-instructor",
        lmsUserId: "lms-admin-console-instructor",
        name: "Console Instructor",
        role: "instructor",
        courseId: "pact-console",
        cohortId: "cohort-console-a",
        createdAt: now,
        updatedAt: now
      }
    ]);

    const adminToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "admin-console-admin",
      role: "admin",
      courseId: "pact-console",
      cohortId: "cohort-console-a"
    });
    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "admin-console-learner",
      role: "learner",
      courseId: "pact-console",
      cohortId: "cohort-console-a"
    });

    await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/cohorts")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(403);

    const listResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/cohorts")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(listResponse.body.cohorts[0]).toMatchObject({
      courseId: "pact-console",
      cohortId: "cohort-console-a",
      users: expect.arrayContaining([
        expect.objectContaining({ id: "admin-console-learner", role: "learner", name: "Console Learner" }),
        expect.objectContaining({ id: "admin-console-instructor", role: "instructor", name: "Console Instructor" })
      ])
    });
    expect(JSON.stringify(listResponse.body)).not.toContain("lms-admin-console-learner");

    const assignResponse = await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/users/admin-console-learner/squad")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ squadNumber: "3" })
      .expect(200);

    expect(assignResponse.body).toMatchObject({
      id: "admin-console-learner",
      role: "learner",
      cohortId: "cohort-console-a",
      squadId: expect.any(String)
    });

    const refreshedResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/cohorts")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(refreshedResponse.body.cohorts[0].squads).toEqual([
      expect.objectContaining({ name: "Squad 3", number: "3" })
    ]);
    expect(refreshedResponse.body.cohorts[0].users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "admin-console-learner", squadId: assignResponse.body.squadId })
      ])
    );

    const auditEvent = await db.collection("test_pactAuditEvents").findOne({
      action: "squad.assignment.changed",
      actorUserId: "admin-console-admin",
      targetUserId: "admin-console-learner"
    });
    expect(auditEvent).toMatchObject({
      courseId: "pact-console",
      cohortId: "cohort-console-a",
      metadata: {
        nextSquadId: assignResponse.body.squadId,
        nextSquadNumber: "3"
      }
    });
    await db.collection("test_pactAuditEvents").insertMany([
      {
        id: "manual-audit-console",
        action: "question.manual_grade.upserted",
        actorUserId: "admin-console-admin",
        targetUserId: "admin-console-learner",
        courseId: "pact-console",
        cohortId: "cohort-console-a",
        metadata: {
          contentId: "content-console",
          questionId: "question-console",
          attemptId: "attempt-console",
          previousScore: 1,
          nextScore: 4,
          maxScore: 5,
          feedbackChanged: true
        },
        createdAt: new Date(Date.now() + 1000).toISOString()
      },
      {
        id: "ags-audit-console",
        action: "ags.queue.process_due.triggered",
        actorUserId: "admin-console-admin",
        targetUserId: "admin-console-admin",
        courseId: "pact-console",
        cohortId: "cohort-console-a",
        metadata: { scanned: 2, retried: 1, failed: 1, exhausted: 0, limit: 25 },
        createdAt: new Date(Date.now() + 2000).toISOString()
      }
    ]);

    await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/audit-events")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(403);

    const auditResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/audit-events")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(auditResponse.body.events[0]).toMatchObject({
      action: "ags.queue.process_due.triggered",
      scanned: 2,
      retried: 1,
      failed: 1,
      exhausted: 0
    });

    const manualAuditResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/audit-events?action=question.manual_grade.upserted")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(manualAuditResponse.body.events).toHaveLength(1);
    expect(manualAuditResponse.body.events[0]).toMatchObject({
      action: "question.manual_grade.upserted",
      contentId: "content-console",
      questionId: "question-console",
      attemptId: "attempt-console",
      nextScore: 4,
      maxScore: 5,
      feedbackChanged: true
    });

    const squadAuditResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/audit-events?action=squad.assignment.changed")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(squadAuditResponse.body.events[0]).toMatchObject({
      action: "squad.assignment.changed",
      actorUserId: "admin-console-admin",
      targetUserId: "admin-console-learner",
      targetName: "Console Learner",
      courseId: "pact-console",
      cohortId: "cohort-console-a",
      nextSquadId: assignResponse.body.squadId,
      nextSquadNumber: "3"
    });
    expect(JSON.stringify(auditResponse.body)).not.toContain("lms-admin-console-learner");
  });

  it("carries learner-owned scores and progress when an admin reassigns squads", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactSquads").insertMany([
      { id: "carry-squad-1", courseId: "pact-carry", cohortId: "cohort-carry", name: "Squad 1", number: "1", createdAt: now, updatedAt: now },
      { id: "carry-squad-2", courseId: "pact-carry", cohortId: "cohort-carry", name: "Squad 2", number: "2", createdAt: now, updatedAt: now }
    ]);
    await db.collection("test_pactUsers").insertMany([
      { id: "carry-admin", lmsUserId: "lms-carry-admin", role: "admin", courseId: "pact-carry", cohortId: "cohort-carry", createdAt: now, updatedAt: now },
      {
        id: "carry-learner",
        lmsUserId: "lms-carry-learner",
        name: "Elizabeth Sanders",
        email: "elizabeth.sanders@example.test",
        role: "learner",
        courseId: "pact-carry",
        cohortId: "cohort-carry",
        squadId: "carry-squad-1",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactScores").insertOne({
      id: "carry-score",
      courseId: "pact-carry",
      cohortId: "cohort-carry",
      squadId: "carry-squad-1",
      userId: "carry-learner",
      contentId: "carry-module",
      contentType: "module",
      score: 8,
      maxScore: 10,
      progressPercent: 80,
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactContentProgress").insertMany([
      {
        id: "carry-user-progress",
        scope: "user",
        courseId: "pact-carry",
        cohortId: "cohort-carry",
        squadId: "carry-squad-1",
        userId: "carry-learner",
        contentId: "carry-module",
        contentType: "module",
        answers: {},
        answeredQuestionIds: [],
        progressPercent: 80,
        status: "submitted",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "carry-squad-progress",
        scope: "squad",
        courseId: "pact-carry",
        cohortId: "cohort-carry",
        squadId: "carry-squad-1",
        userId: "squad:carry-squad-1",
        updatedByUserId: "carry-learner",
        contentId: "carry-workshop",
        contentType: "workshop",
        answers: {},
        answeredQuestionIds: [],
        progressPercent: 100,
        status: "submitted",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactQuestionAttempts").insertOne({
      id: "carry-attempt",
      courseId: "pact-carry",
      cohortId: "cohort-carry",
      squadId: "carry-squad-1",
      userId: "carry-learner",
      contentId: "carry-module",
      contentType: "module",
      questionId: "carry-question",
      attemptNumber: 1,
      answer: "A",
      score: 1,
      maxScore: 1,
      isCorrect: true,
      feedbackExposed: true,
      submittedAt: now
    });
    await db.collection("test_pactAgsPublishAttempts").insertOne({
      id: "carry-ags",
      courseId: "pact-carry",
      cohortId: "cohort-carry",
      squadId: "carry-squad-1",
      userId: "carry-learner",
      contentId: "carry-module",
      contentType: "module",
      status: "pending",
      attemptCount: 0,
      score: 8,
      maxScore: 10,
      progressPercent: 80,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now
    });
    const adminToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "carry-admin",
      role: "admin",
      courseId: "pact-carry",
      cohortId: "cohort-carry"
    });

    const response = await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/users/carry-learner/squad")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ squadNumber: "2" })
      .expect(200);

    expect(response.body).toMatchObject({ squadId: "carry-squad-2" });
    await expect(db.collection("test_pactScores").findOne({ id: "carry-score" })).resolves.toMatchObject({ squadId: "carry-squad-2" });
    await expect(db.collection("test_pactContentProgress").findOne({ id: "carry-user-progress" })).resolves.toMatchObject({ squadId: "carry-squad-2" });
    await expect(db.collection("test_pactQuestionAttempts").findOne({ id: "carry-attempt" })).resolves.toMatchObject({ squadId: "carry-squad-2" });
    await expect(db.collection("test_pactAgsPublishAttempts").findOne({ id: "carry-ags" })).resolves.toMatchObject({ squadId: "carry-squad-2" });
    await expect(db.collection("test_pactContentProgress").findOne({ id: "carry-squad-progress" })).resolves.toMatchObject({ squadId: "carry-squad-1" });
    await expect(db.collection("test_pactAuditEvents").findOne({ targetUserId: "carry-learner", action: "squad.assignment.changed" })).resolves.toMatchObject({
      metadata: {
        previousSquadId: "carry-squad-1",
        nextSquadId: "carry-squad-2",
        carriedScores: 1,
        carriedProgress: 1,
        carriedQuestionAttempts: 1,
        carriedAgsPublishAttempts: 1
      }
    });
  });

  it("lets instructors use the course control plane without learner access", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "control-plane-instructor",
        lmsUserId: "lms-control-plane-instructor",
        name: "Control Instructor",
        role: "instructor",
        courseId: "pact-control-plane",
        cohortId: "cohort-control-a",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "control-plane-learner-a",
        lmsUserId: "lms-control-plane-learner-a",
        name: "Control Learner A",
        role: "learner",
        courseId: "pact-control-plane",
        cohortId: "cohort-control-a",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "control-plane-learner-b",
        lmsUserId: "lms-control-plane-learner-b",
        name: "Control Learner B",
        role: "learner",
        courseId: "pact-control-plane",
        cohortId: "cohort-control-b",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "control-plane-other-course-learner",
        lmsUserId: "lms-control-plane-other-course-learner",
        name: "Other Course Learner",
        role: "learner",
        courseId: "pact-other-course",
        cohortId: "cohort-other",
        createdAt: now,
        updatedAt: now
      }
    ]);

    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "control-plane-instructor",
      role: "instructor",
      courseId: "pact-control-plane",
      cohortId: "cohort-control-a"
    });
    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "control-plane-learner-a",
      role: "learner",
      courseId: "pact-control-plane",
      cohortId: "cohort-control-a"
    });

    await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/cohorts")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(403);

    const cohortResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/cohorts")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);

    expect(cohortResponse.body.cohorts.map((cohort: { cohortId: string }) => cohort.cohortId)).toEqual([
      "cohort-control-a",
      "cohort-control-b"
    ]);
    expect(JSON.stringify(cohortResponse.body)).toContain("Control Learner B");
    expect(JSON.stringify(cohortResponse.body)).not.toContain("Other Course Learner");

    const assignResponse = await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/users/control-plane-learner-b/squad")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ squadNumber: "2" })
      .expect(200);

    expect(assignResponse.body).toMatchObject({
      id: "control-plane-learner-b",
      courseId: "pact-control-plane",
      cohortId: "cohort-control-b",
      squadId: expect.any(String)
    });

    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/users/control-plane-other-course-learner/squad")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ squadNumber: "1" })
      .expect(403);
  });

  it("lets admins and instructors assign content delivery to cohorts within the launched course", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "content-control-admin",
        lmsUserId: "lms-content-control-admin",
        role: "admin",
        courseId: "pact-content-control",
        cohortId: "cohort-content-a",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "content-control-instructor",
        lmsUserId: "lms-content-control-instructor",
        role: "instructor",
        courseId: "pact-content-control",
        cohortId: "cohort-content-a",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactContent").insertMany([
      { ...publishedContent("content-control-module", null, "learner", "draft"), courseId: "pact-content-control" },
      { ...publishedContent("content-control-game", null, "learner", "draft", "game"), courseId: "pact-content-control" },
      { ...publishedContent("content-control-other-course", null, "learner", "draft"), courseId: "pact-content-other-course" }
    ]);

    const adminToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "content-control-admin",
      role: "admin",
      courseId: "pact-content-control",
      cohortId: "cohort-content-a"
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "content-control-instructor",
      role: "instructor",
      courseId: "pact-content-control",
      cohortId: "cohort-content-a"
    });

    const adminAssignResponse = await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/content/content-control-module/assignment")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ cohortId: "cohort-content-b" })
      .expect(200);

    expect(adminAssignResponse.body).toMatchObject({
      id: "content-control-module",
      courseId: "pact-content-control",
      cohortId: "cohort-content-b"
    });

    const instructorAssignResponse = await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/content/content-control-module/assignment")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ cohortId: null })
      .expect(200);

    expect(instructorAssignResponse.body).toMatchObject({
      id: "content-control-module",
      courseId: "pact-content-control",
      cohortId: null
    });

    const lmsLabelResponse = await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/content/content-control-module/lms-label")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ lmsLabel: "PACT LMS Module Launch" })
      .expect(200);

    expect(lmsLabelResponse.body).toMatchObject({
      id: "content-control-module",
      courseId: "pact-content-control",
      lmsLabel: "PACT LMS Module Launch"
    });

    const mechanicsResponse = await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/content/content-control-game/mechanics")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({
        mechanics: {
          kind: "packet_capture",
          title: "Packet Capture",
          prompt: "Capture evidence nodes.",
          nodes: [
            { id: "dns", label: "DNS", points: 5 },
            { id: "proxy", label: "Proxy", points: 10 }
          ],
          maxScore: 15
        }
      })
      .expect(200);

    expect(mechanicsResponse.body).toMatchObject({
      id: "content-control-game",
      mechanics: { kind: "packet_capture", maxScore: 15 }
    });

    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/content/content-control-game/mechanics")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({
        mechanics: {
          kind: "readiness_checklist",
          title: "Wrong shell",
          prompt: "Wrong shell.",
          checks: [{ id: "ready", label: "Ready" }]
        }
      })
      .expect(400);

    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/content/content-control-other-course/lms-label")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ lmsLabel: "Wrong Course Label" })
      .expect(403);

    const createResponse = await request(createApp(config, createLogger(config)))
      .post("/api/v1/admin/content")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({
        id: "content-control-created",
        courseId: "pact-content-control",
        cohortId: "cohort-content-b",
        role: "learner",
        type: "module",
        title: "Cohort B Scenario",
        prompt: "Complete the scenario",
        maxScore: 10,
        status: "published"
      })
      .expect(201);

    expect(createResponse.body).toMatchObject({
      id: "content-control-created",
      courseId: "pact-content-control",
      cohortId: "cohort-content-b",
      locked: true,
      status: "published"
    });

    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/content/content-control-other-course/assignment")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ cohortId: "cohort-content-a" })
      .expect(403);

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/admin/content")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({
        id: "content-control-cross-course",
        courseId: "pact-content-other-course",
        role: "learner",
        type: "module",
        title: "Wrong Course Scenario",
        prompt: "Should not be created",
        maxScore: 10
      })
      .expect(403);
  });

  it("atomically imports challenge release files from R2 into content mechanics", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("release-import-challenge", "cohort-release-import", "learner", "draft", "challenge", true),
      mechanics: {
        kind: "challenge_path",
        title: "Brokered Exit",
        prompt: "Review released case files.",
        releases: [
          {
            id: "release_R0",
            title: "Existing Release Zero",
            summary: "Preserved release metadata.",
            releaseLabel: "R0",
            unlocked: true,
            files: [{ key: "old/release_R0/old.txt", title: "Old" }],
            questionIds: ["release-import-q0"]
          }
        ],
        paths: [{ id: "develop", label: "Develop", detail: "Build the case.", score: 100 }]
      },
      createdAt: now,
      updatedAt: now
    });

    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "release-import-instructor",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-release-import"
    });
    const r2Config = {
      ...config,
      r2Endpoint: "https://test-account.r2.cloudflarestorage.com",
      r2AccessKeyId: "test-access",
      r2SecretAccessKey: "test-secret",
      r2BucketName: "pact"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`
      <ListBucketResult>
        <Contents><Key>scenarios/brokered-exit/Student/Case Files/release_R0/brief.docx</Key><LastModified>2026-05-18T12:00:00.000Z</LastModified><ETag>"etag-r0"</ETag><Size>128</Size></Contents>
        <Contents><Key>scenarios/brokered-exit/Student/Case Files/release_R1/email.eml</Key><LastModified>2026-05-18T12:05:00.000Z</LastModified><ETag>"etag-r1"</ETag><Size>256</Size></Contents>
        <Contents><Key>scenarios/brokered-exit/Student/Case Files/release_R1/empty.txt</Key><LastModified>2026-05-18T12:06:00.000Z</LastModified><ETag>"etag-empty"</ETag><Size>0</Size></Contents>
      </ListBucketResult>
    `, { status: 200 }));

    try {
      const response = await request(createApp(r2Config, createLogger(r2Config)))
        .post("/api/v1/admin/content/release-import-challenge/releases/import")
        .set("authorization", `Bearer ${instructorToken}`)
        .send({ prefix: "pact/scenarios/brokered-exit/Student/Case Files/" })
        .expect(200);

      expect(response.body).toMatchObject({ imported: 2, releases: 2 });
      expect(response.body.content).toMatchObject({ status: "published", locked: false });
      expect(response.body.content.mechanics.releases).toEqual([
        expect.objectContaining({
          id: "release_R0",
          title: "Existing Release Zero",
          summary: "Preserved release metadata.",
          unlocked: true,
          questionIds: ["release-import-q0"],
          files: [expect.objectContaining({ key: "scenarios/brokered-exit/Student/Case Files/release_R0/brief.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]
        }),
        expect.objectContaining({
          id: "release_R1",
          title: "Release R1",
          unlocked: false,
          files: [expect.objectContaining({ key: "scenarios/brokered-exit/Student/Case Files/release_R1/email.eml", contentType: "message/rfc822" })]
        })
      ]);
      const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(listUrl.searchParams.get("prefix")).toBe("scenarios/brokered-exit/Student/Case Files/");

      const persisted = await db.collection("test_pactContent").findOne({ id: "release-import-challenge" });
      expect(persisted?.mechanics).toMatchObject(response.body.content.mechanics);
      expect(persisted).toMatchObject({ status: "published", locked: false });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not modify challenge mechanics when a release import finds no files", async () => {
    const db = await getMongoDb(config);
    const originalMechanics = {
      kind: "challenge_path",
      title: "Brokered Exit Empty Import",
      prompt: "Keep the existing mechanics.",
      releases: [
        {
          id: "release_R0",
          title: "Release R0",
          summary: "Existing file.",
          unlocked: true,
          files: [{ key: "existing/release_R0/brief.txt", title: "Brief" }]
        }
      ],
      paths: [{ id: "develop", label: "Develop", detail: "Build the case.", score: 100 }]
    };
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("release-import-empty-challenge", "cohort-release-import", "learner", "draft", "challenge", true),
      mechanics: originalMechanics
    });

    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "release-import-empty-instructor",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-release-import"
    });
    const r2Config = {
      ...config,
      r2Endpoint: "https://test-account.r2.cloudflarestorage.com",
      r2AccessKeyId: "test-access",
      r2SecretAccessKey: "test-secret",
      r2BucketName: "pact"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<ListBucketResult />", { status: 200 }));

    try {
      await request(createApp(r2Config, createLogger(r2Config)))
        .post("/api/v1/admin/content/release-import-empty-challenge/releases/import")
        .set("authorization", `Bearer ${instructorToken}`)
        .send({ prefix: "pact/scenarios/brokered-exit/Student/Case Files/" })
        .expect(404);

      const persisted = await db.collection("test_pactContent").findOne({ id: "release-import-empty-challenge" });
      expect(persisted?.mechanics).toEqual(originalMechanics);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("imports slide decks and only exposes them to learners after instructor unlock", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactUsers").insertOne({
      id: "deck-learner",
      lmsUserId: "lms-deck-learner",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-deck",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await db.collection("test_pactContent").insertOne(publishedContent("deck-module", "cohort-deck", "learner", "published", "module", false));

    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "deck-instructor",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-deck"
    });
    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "deck-learner",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-deck"
    });
    const r2Config = {
      ...config,
      r2Endpoint: "https://test-account.r2.cloudflarestorage.com",
      r2AccessKeyId: "test-access",
      r2SecretAccessKey: "test-secret",
      r2BucketName: "pact"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`
      <ListBucketResult>
        <Contents><Key>decks/Attribution/Attribution 101.pptx</Key><LastModified>2026-05-18T12:00:00.000Z</LastModified><ETag>"deck-pptx"</ETag><Size>128</Size></Contents>
        <Contents><Key>decks/Attribution/Attribution quick reference.pdf</Key><LastModified>2026-05-18T12:05:00.000Z</LastModified><ETag>"deck-pdf"</ETag><Size>256</Size></Contents>
        <Contents><Key>decks/Attribution/day4_lecture1_lesson_plan.docx</Key><LastModified>2026-05-18T12:06:00.000Z</LastModified><ETag>"deck-guide"</ETag><Size>512</Size></Contents>
      </ListBucketResult>
    `, { status: 200 }));

    try {
      const importResponse = await request(createApp(r2Config, createLogger(r2Config)))
        .post("/api/v1/admin/content/deck-module/decks/import")
        .set("authorization", `Bearer ${instructorToken}`)
        .send({ prefix: "pact/decks/Attribution/" })
        .expect(200);

      expect(importResponse.body).toMatchObject({ imported: 2 });
      expect(importResponse.body.content.deck).toMatchObject({ unlocked: false, prefix: "pact/decks/Attribution/" });
      expect(importResponse.body.content.deck.files.map((file: { key: string }) => file.key)).toEqual([
        "decks/Attribution/Attribution 101.pptx",
        "decks/Attribution/Attribution quick reference.pdf"
      ]);
      expect(importResponse.body.content.deck.instructorGuideFiles.map((file: { key: string }) => file.key)).toEqual([
        "decks/Attribution/day4_lecture1_lesson_plan.docx"
      ]);

      const lockedLearnerResponse = await request(createApp(r2Config, createLogger(r2Config)))
        .get("/api/v1/content")
        .set("authorization", `Bearer ${learnerToken}`)
        .expect(200);
      expect(lockedLearnerResponse.body.find((item: { id: string }) => item.id === "deck-module").deck).toBeUndefined();

      await request(createApp(r2Config, createLogger(r2Config)))
        .patch("/api/v1/admin/content/deck-module/deck-lock")
        .set("authorization", `Bearer ${instructorToken}`)
        .send({ unlocked: true })
        .expect(200);

      const unlockedLearnerResponse = await request(createApp(r2Config, createLogger(r2Config)))
        .get("/api/v1/content")
        .set("authorization", `Bearer ${learnerToken}`)
        .expect(200);
      const deckModule = unlockedLearnerResponse.body.find((item: { id: string }) => item.id === "deck-module");
      expect(deckModule.deck.files).toHaveLength(2);
      expect(deckModule.deck.instructorGuideFiles).toBeUndefined();
      expect(deckModule.deck.files[0].viewUrl).toContain("X-Amz-Signature=");
      expect(deckModule.deck.files[0].downloadUrl).toContain("response-content-disposition=");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("publishes and unlocks a challenge when an instructor unlocks scenario releases", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertOne({
      id: "release-unlock-learner",
      lmsUserId: "lms-release-unlock-learner",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-release-unlock",
      squadId: "release-unlock-squad",
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("release-unlock-challenge", "cohort-release-unlock", "learner", "draft", "challenge", true),
      mechanics: {
        kind: "challenge_path",
        title: "Release Unlock Challenge",
        prompt: "Review newly released scenario evidence.",
        releases: [
          {
            id: "release_R0",
            title: "Release R0",
            summary: "Initial release.",
            unlocked: false,
            files: [{ key: "scenarios/release_R0/brief.txt", title: "Brief" }]
          }
        ],
        paths: [{ id: "develop", label: "Develop", detail: "Build the case.", score: 100 }]
      },
      updatedAt: now
    });

    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "release-unlock-instructor",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-release-unlock"
    });
    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "release-unlock-learner",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-release-unlock",
      squadId: "release-unlock-squad"
    });

    const mechanics = {
      kind: "challenge_path",
      title: "Release Unlock Challenge",
      prompt: "Review newly released scenario evidence.",
      releases: [
        {
          id: "release_R0",
          title: "Release R0",
          summary: "Initial release.",
          unlocked: true,
          files: [{ key: "scenarios/release_R0/brief.txt", title: "Brief" }]
        }
      ],
      paths: [{ id: "develop", label: "Develop", detail: "Build the case.", score: 100 }]
    };

    const updateResponse = await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/content/release-unlock-challenge/mechanics")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ mechanics })
      .expect(200);

    expect(updateResponse.body).toMatchObject({
      id: "release-unlock-challenge",
      status: "published",
      locked: false,
      mechanics: { releases: [expect.objectContaining({ id: "release_R0", unlocked: true })] }
    });

    const learnerResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(200);

    expect(learnerResponse.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "release-unlock-challenge",
        status: "published",
        locked: false,
        mechanics: expect.objectContaining({
          releases: expect.arrayContaining([expect.objectContaining({ id: "release_R0", unlocked: true })])
        })
      })
    ]));
  });

  it("serves cohort agenda files to learners without admin document access", async () => {
    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "agenda-learner",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-agenda"
    });
    const r2Config = {
      ...config,
      r2Endpoint: "https://test-account.r2.cloudflarestorage.com",
      r2AccessKeyId: "test-access",
      r2SecretAccessKey: "test-secret",
      r2BucketName: "pact"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`
      <ListBucketResult>
        <Contents><Key>Agendas/pact/cohort-agenda/day-1-agenda.pdf</Key><LastModified>2026-05-18T12:00:00.000Z</LastModified><ETag>"agenda"</ETag><Size>128</Size></Contents>
      </ListBucketResult>
    `, { status: 200 }));

    try {
      const response = await request(createApp(r2Config, createLogger(r2Config)))
        .get("/api/v1/agenda")
        .set("authorization", `Bearer ${learnerToken}`)
        .expect(200);

      expect(response.body.documents).toHaveLength(1);
      expect(response.body.documents[0]).toMatchObject({
        key: "Agendas/pact/cohort-agenda/day-1-agenda.pdf",
        size: 128
      });
      expect(response.body.documents[0].downloadUrl).toContain("X-Amz-Signature=");
      const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(listUrl.searchParams.get("prefix")).toBe("Agendas/pact/cohort-agenda/");

      await request(createApp(r2Config, createLogger(r2Config)))
        .get("/api/v1/admin/r2/documents")
        .set("authorization", `Bearer ${learnerToken}`)
        .expect(403);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("allows instructors to upload cohort agendas to the agenda R2 prefix", async () => {
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "agenda-instructor",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-agenda"
    });
    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "agenda-upload-learner",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-agenda"
    });
    const r2Config = {
      ...config,
      r2Endpoint: "https://test-account.r2.cloudflarestorage.com",
      r2AccessKeyId: "test-access",
      r2SecretAccessKey: "test-secret",
      r2BucketName: "pact"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", {
      status: 200,
      headers: { etag: "\"uploaded-agenda\"" }
    }));

    try {
      const response = await request(createApp(r2Config, createLogger(r2Config)))
        .post("/api/v1/admin/agenda")
        .set("authorization", `Bearer ${instructorToken}`)
        .send({
          fileName: "../Day 1 Agenda.pdf",
          contentType: "application/pdf",
          bodyBase64: Buffer.from("agenda content").toString("base64")
        })
        .expect(201);

      expect(response.body.document).toMatchObject({
        key: "Agendas/pact/cohort-agenda/Day 1 Agenda.pdf",
        size: 14,
        etag: "\"uploaded-agenda\""
      });
      const putUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(putUrl.pathname).toBe("/pact/Agendas/pact/cohort-agenda/Day%201%20Agenda.pdf");
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");

      await request(createApp(r2Config, createLogger(r2Config)))
        .post("/api/v1/admin/agenda")
        .set("authorization", `Bearer ${learnerToken}`)
        .send({
          fileName: "learner-agenda.pdf",
          contentType: "application/pdf",
          bodyBase64: Buffer.from("blocked").toString("base64")
        })
        .expect(403);
    } finally {
      fetchMock.mockRestore();
    }
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

  it("returns cohort scoreboard progress across squads", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "scoreboard-cross-squad-current",
        lmsUserId: "lms-scoreboard-cross-squad-current",
        name: "Current Learner",
        role: "learner",
        courseId: "pact",
        cohortId: "scoreboard-cross-squad",
        squadId: "scoreboard-squad-1",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "scoreboard-cross-squad-peer",
        lmsUserId: "lms-scoreboard-cross-squad-peer",
        name: "Peer Learner",
        role: "learner",
        courseId: "pact",
        cohortId: "scoreboard-cross-squad",
        squadId: "scoreboard-squad-2",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactScores").insertMany([
      {
        id: "scoreboard-cross-squad-current-score",
        courseId: "pact",
        cohortId: "scoreboard-cross-squad",
        squadId: "scoreboard-squad-1",
        userId: "scoreboard-cross-squad-current",
        contentId: "scoreboard-cross-squad-content",
        contentType: "module",
        score: 5,
        maxScore: 10,
        progressPercent: 50,
        agsStatus: "not_applicable",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "scoreboard-cross-squad-peer-score",
        courseId: "pact",
        cohortId: "scoreboard-cross-squad",
        squadId: "scoreboard-squad-2",
        userId: "scoreboard-cross-squad-peer",
        contentId: "scoreboard-cross-squad-content",
        contentType: "module",
        score: 9,
        maxScore: 10,
        progressPercent: 90,
        agsStatus: "not_applicable",
        createdAt: now,
        updatedAt: now
      }
    ]);

    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "scoreboard-cross-squad-current",
      role: "learner",
      courseId: "pact",
      cohortId: "scoreboard-cross-squad",
      squadId: "scoreboard-squad-1"
    });

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/dashboard/scoreboard")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.entries).toEqual([
      expect.objectContaining({ userId: "scoreboard-cross-squad-peer", totalScore: 9, progressPercent: 90 }),
      expect.objectContaining({ userId: "scoreboard-cross-squad-current", totalScore: 5, progressPercent: 50 })
    ]);
  });

  it("keeps explicit partial score submissions internal until assignment progress is complete", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactContent").updateOne(
      { id: "partial-score-content" },
      {
        $set: {
          ...publishedContent("partial-score-content", "cohort-a", "learner", "published", "module"),
          lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/partial-score"
        }
      },
      { upsert: true }
    );
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    try {
      const response = await request(createApp(config, createLogger(config)))
        .post("/api/v1/scores")
        .set("authorization", `Bearer ${token}`)
        .send({ contentId: "partial-score-content", score: 4, maxScore: 10, progressPercent: 40, agsAccessToken: "partial-token" })
        .expect(201);

      expect(response.body).toMatchObject({
        contentId: "partial-score-content",
        score: 4,
        maxScore: 10,
        progressPercent: 40,
        agsStatus: "not_ready"
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await db.collection("test_pactAgsPublishAttempts").findOne({ contentId: "partial-score-content" })).toBeNull();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("packages assessment session timing with the LMS AGS score", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactContent").updateOne(
      { id: "timed-assessment-content" },
      {
        $set: {
          ...publishedContent("timed-assessment-content", "cohort-a", "learner", "published", "assessment"),
          lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/timed-assessment",
          mechanics: {
            kind: "readiness_checklist",
            title: "Timed assessment",
            prompt: "Start and submit timing is included in the LMS score package.",
            resultLabel: "Readiness",
            timing: {
              enabled: true,
              timeLimitSeconds: 600,
              startTrigger: "learner_start",
              submitTrigger: "content_submit"
            },
            checks: [{ id: "ready", label: "Ready" }]
          }
        }
      },
      { upsert: true }
    );
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    try {
      const progressResponse = await request(createApp(config, createLogger(config)))
        .patch("/api/v1/content/timed-assessment-content/progress")
        .set("authorization", `Bearer ${token}`)
        .send({
          mechanicsState: {
            kind: "readiness_checklist",
            checkedIds: ["ready"],
            startedAt,
            timing: {
              startTrigger: "learner_start",
              submitTrigger: "content_submit",
              timeLimitSeconds: 600
            }
          },
          progressPercent: 100,
          status: "in_progress"
        })
        .expect(200);

      expect(progressResponse.body).toMatchObject({
        contentId: "timed-assessment-content",
        status: "in_progress",
        startedAt
      });

      await request(createApp(config, createLogger(config)))
        .post("/api/v1/scores")
        .set("authorization", `Bearer ${token}`)
        .send({ contentId: "timed-assessment-content", score: 10, maxScore: 10, progressPercent: 100, agsAccessToken: "timing-token" })
        .expect(201);

      expect(fetchMock).toHaveBeenCalledWith(
        "http://lms.example.test/api/v1/lti/ags/lineitems/timed-assessment/scores",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer timing-token" })
        })
      );
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const timingPackage = JSON.parse(body.comment).pactAssessmentTiming;
      expect(timingPackage).toMatchObject({
        contentId: "timed-assessment-content",
        contentType: "assessment",
        startTrigger: "learner_start",
        submitTrigger: "content_submit",
        startedAt,
        timeLimitSeconds: 600,
        expired: false
      });
      expect(timingPackage.submittedAt).toEqual(expect.any(String));
      expect(timingPackage.elapsedSeconds).toBeGreaterThanOrEqual(100);

      const submitted = await db.collection("test_pactContentProgress").findOne({ userId: "user-1", contentId: "timed-assessment-content" });
      expect(submitted).toMatchObject({ startedAt, status: "submitted", submittedAt: expect.any(String) });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("requires question assessments to start before answer submission and queues AGS timing metadata", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactContent").updateOne(
      { id: "question-timed-assessment" },
      {
        $set: {
          ...publishedContent("question-timed-assessment", "cohort-a", "learner", "published", "assessment"),
          lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/question-timed-assessment",
          questionCount: 2,
          mechanics: {
            kind: "readiness_checklist",
            title: "Question timed assessment",
            prompt: "Complete this question assessment in one sitting.",
            timing: {
              enabled: true,
              timeLimitSeconds: 120,
              startTrigger: "learner_start",
              submitTrigger: "content_submit"
            },
            checks: [{ id: "assessment-start", label: "Assessment started" }]
          },
          questions: [
            {
              id: "question-timed-q1",
              version: 1,
              topic: "First",
              payload: { kind: "true_false", correct: true },
              feedback: { correct: { en: "Right." }, incorrect: { en: "Review the item." } },
              scoring: { points: 4, difficulty: "easy", mustPass: false }
            },
            {
              id: "question-timed-q2",
              version: 1,
              topic: "Second",
              payload: { kind: "multiple_choice", correct: ["b"] },
              feedback: { correct: { en: "Good choice." }, incorrect: { en: "Review the scenario." } },
              scoring: { points: 6, difficulty: "easy", mustPass: false }
            }
          ]
        }
      },
      { upsert: true }
    );
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/question-timed-assessment/questions/question-timed-q1/attempts")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: true, feedbackExposed: true })
      .expect(409);

    const startedAt = new Date(Date.now() - 90_000).toISOString();
    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/content/question-timed-assessment/progress")
      .set("authorization", `Bearer ${token}`)
      .send({
        mechanicsState: {
          kind: "assessment_session",
          startedAt,
          timing: {
            startTrigger: "learner_start",
            submitTrigger: "content_submit"
          }
        },
        progressPercent: 0,
        status: "in_progress"
      })
      .expect(200);

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/question-timed-assessment/questions/question-timed-q1/attempts")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: true, feedbackExposed: true })
      .expect(201);
    const finalAttempt = await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/question-timed-assessment/questions/question-timed-q2/attempts")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: ["b"], feedbackExposed: true })
      .expect(201);

    expect(finalAttempt.body.progress).toMatchObject({
      contentId: "question-timed-assessment",
      status: "submitted",
      startedAt,
      submittedAt: expect.any(String)
    });

    const queuedAttempt = await db.collection("test_pactAgsPublishAttempts").findOne({
      userId: "user-1",
      contentId: "question-timed-assessment"
    });
    expect(queuedAttempt).toMatchObject({
      status: "pending",
      score: 10,
      maxScore: 10,
      progressPercent: 100
    });
    const timingPackage = JSON.parse(queuedAttempt?.comment as string).pactAssessmentTiming;
    expect(timingPackage).toMatchObject({
      contentId: "question-timed-assessment",
      contentType: "assessment",
      startTrigger: "learner_start",
      submitTrigger: "content_submit",
      startedAt,
      timeLimitSeconds: 120,
      expired: false
    });
    expect(timingPackage.elapsedSeconds).toBeGreaterThanOrEqual(80);

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/question-timed-assessment/questions/question-timed-q2/attempts")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: ["b"], feedbackExposed: true })
      .expect(409);
  });

  it("does not republish identical already-published scores to LMS AGS", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactContent").updateOne(
      { id: "ags-idempotent-content" },
      {
        $set: {
          ...publishedContent("ags-idempotent-content", "cohort-a", "learner", "published", "module"),
          lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/lineitem-1"
        }
      },
      { upsert: true }
    );
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    try {
      await request(createApp(config, createLogger(config)))
        .post("/api/v1/scores")
        .set("authorization", `Bearer ${token}`)
        .send({ contentId: "ags-idempotent-content", score: 9, maxScore: 10, progressPercent: 100, agsAccessToken: "ags-token" })
        .expect(201);

      await request(createApp(config, createLogger(config)))
        .post("/api/v1/scores")
        .set("authorization", `Bearer ${token}`)
        .send({ contentId: "ags-idempotent-content", score: 9, maxScore: 10, progressPercent: 100, agsAccessToken: "ags-token" })
        .expect(201);

      expect(fetchMock).toHaveBeenCalledTimes(1);

      await request(createApp(config, createLogger(config)))
        .post("/api/v1/scores")
        .set("authorization", `Bearer ${token}`)
        .send({ contentId: "ags-idempotent-content", score: 10, maxScore: 10, progressPercent: 100, agsAccessToken: "ags-token" })
        .expect(201);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const attempts = await db.collection("test_pactAgsPublishAttempts")
        .find({ contentId: "ags-idempotent-content", userId: "user-1" })
        .sort({ createdAt: 1 })
        .toArray();
      expect(attempts.map((attempt) => attempt.status)).toEqual(["published", "skipped_duplicate", "published"]);
      expect(JSON.stringify(attempts)).not.toContain("ags-token");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("records failed LMS AGS publish attempts without storing access tokens", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactContent").updateOne(
      { id: "ags-failure-content" },
      {
        $set: {
          ...publishedContent("ags-failure-content", "cohort-a", "learner", "published", "module"),
          lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/lineitem-fail"
        }
      },
      { upsert: true }
    );
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    try {
      await request(createApp(config, createLogger(config)))
        .post("/api/v1/scores")
        .set("authorization", `Bearer ${token}`)
        .send({ contentId: "ags-failure-content", score: 7, maxScore: 10, progressPercent: 100, agsAccessToken: "failed-token" })
        .expect(502);

      const attempt = await db.collection("test_pactAgsPublishAttempts").findOne({
        contentId: "ags-failure-content",
        userId: "user-1"
      });
      expect(attempt).toMatchObject({
        status: "failed",
        errorCode: "AGS_PUBLISH_FAILED",
        score: 7,
        maxScore: 10,
        progressPercent: 100,
        lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/lineitem-fail"
      });
      expect(JSON.stringify(attempt)).not.toContain("failed-token");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("automatically retries transient AGS failures while the submitted token remains in memory", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactContent").updateOne(
      { id: "ags-auto-retry-content" },
      {
        $set: {
          ...publishedContent("ags-auto-retry-content", "cohort-a", "learner", "published", "module"),
          lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/auto-retry"
        }
      },
      { upsert: true }
    );
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });
    const retryConfig: AppConfig = {
      ...config,
      agsAutoRetryEnabled: true,
      agsAutoRetryMaxAttempts: 1,
      agsAutoRetryInitialDelayMs: 1,
      agsAutoRetryMaxDelayMs: 1
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      await request(createApp(retryConfig, createLogger(retryConfig)))
        .post("/api/v1/scores")
        .set("authorization", `Bearer ${token}`)
        .send({ contentId: "ags-auto-retry-content", score: 5, maxScore: 10, progressPercent: 100, agsAccessToken: "auto-retry-token" })
        .expect(502);

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const attempts = await db.collection("test_pactAgsPublishAttempts")
        .find({ contentId: "ags-auto-retry-content", userId: "user-1" })
        .sort({ createdAt: 1 })
        .toArray();
      expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "published"]);
      expect(attempts[1]).toMatchObject({ retryCount: 1 });
      expect(JSON.stringify(attempts)).not.toContain("auto-retry-token");

      const score = await db.collection("test_pactScores").findOne({ contentId: "ags-auto-retry-content", userId: "user-1" });
      expect(score).toMatchObject({ agsStatus: "published", score: 5 });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("acquires LMS AGS tokens server-side from launch context before publishing scores", async () => {
    const db = await getMongoDb(config);
    const idToken = await signResourceLaunch({
      ags: {
        lineitems: "http://lms.example.test/api/v1/lti/ags/lineitems",
        scope: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"]
      }
    });
    const launchResponse = await request(createApp(config, createLogger(config)))
      .post("/launch/module")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: idToken })
      .expect(200);
    await db.collection("test_pactContent").updateOne(
      { id: "ags-server-token-content" },
      {
        $set: {
          ...publishedContent("ags-server-token-content", "cohort-launch", "learner", "published", "module"),
          lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/server-token-lineitem"
        }
      },
      { upsert: true }
    );
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: launchResponse.body.user.id,
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-launch",
      contentType: "module"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "server-ags-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      await request(createApp(config, createLogger(config)))
        .post("/api/v1/scores")
        .set("authorization", `Bearer ${token}`)
        .send({ contentId: "ags-server-token-content", score: 8, maxScore: 10, progressPercent: 100 })
        .expect(201);

      expect(fetchMock).toHaveBeenNthCalledWith(1, "http://lms.example.test/api/v1/lti/token", expect.objectContaining({
        method: "POST"
      }));
      const tokenBody = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(tokenBody.get("grant_type")).toBe("client_credentials");
      expect(tokenBody.get("scope")).toBe("https://purl.imsglobal.org/spec/lti-ags/scope/score");
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://lms.example.test/api/v1/lti/ags/lineitems/server-token-lineitem/scores",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer server-ags-token" })
        })
      );
      const attempts = await db.collection("test_pactAgsPublishAttempts").find({ contentId: "ags-server-token-content" }).toArray();
      expect(JSON.stringify(attempts)).not.toContain("server-ags-token");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("reports operator AGS token context from the latest launch", async () => {
    const idToken = await signAdminLaunchWithAgs();
    const launchResponse = await request(createApp(config, createLogger(config)))
      .post("/api/v1/lti/launch")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: idToken })
      .expect(200);
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: launchResponse.body.user.id,
      role: "admin",
      courseId: "pact",
      cohortId: "cohort-launch"
    });

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/diagnostics/ags-token-context")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({
      courseId: "pact",
      cohortId: "cohort-launch",
      hasLaunchContext: true,
      hasScoreScope: true,
      lineItemsUrl: "http://lms.example.test/api/v1/lti/ags/lineitems",
      scopes: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"]
    });
  });

  it("durably retries due AGS attempts by acquiring a fresh server-side token", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertOne({
      id: "ags-durable-learner",
      lmsUserId: "lms-ags-durable-learner",
      role: "learner",
      courseId: "pact-ags-durable",
      cohortId: "cohort-a",
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("ags-durable-content", "cohort-a", "learner", "published", "module"),
      courseId: "pact-ags-durable",
      lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/durable-lineitem"
    });
    await db.collection("test_pactAgsContexts").insertOne({
      id: "ags-durable-context",
      courseId: "pact-ags-durable",
      cohortId: "cohort-a",
      userId: "ags-durable-operator",
      lineItemsUrl: "http://lms.example.test/api/v1/lti/ags/lineitems",
      scopes: [
        "https://purl.imsglobal.org/spec/lti-ags/scope/score",
        "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem"
      ],
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactAgsPublishAttempts").insertOne({
      id: "ags-durable-due",
      courseId: "pact-ags-durable",
      cohortId: "cohort-a",
      userId: "ags-durable-learner",
      contentId: "ags-durable-content",
      score: 9,
      maxScore: 10,
      progressPercent: 100,
      status: "failed",
      retryCount: 0,
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: now
    });
    const retryConfig = { ...config, agsAutoRetryEnabled: true, agsAutoRetryMaxAttempts: 2 };
    const repository = new PactRepository(db, retryConfig);
    const service = new AgsMaintenanceService(
      retryConfig,
      repository,
      new PactService(repository, new LmsAgsClient(), new LmsTokenClient(retryConfig), retryConfig),
      createLogger(retryConfig)
    );
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "durable-ags-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      const result = await service.retryDueAgsAttempts();

      expect(result.scanned).toBeGreaterThanOrEqual(1);
      expect(result.retried).toBeGreaterThanOrEqual(1);
      const attempts = await db.collection("test_pactAgsPublishAttempts")
        .find({ courseId: "pact-ags-durable", contentId: "ags-durable-content" })
        .sort({ createdAt: 1 })
        .toArray();
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ status: "published", retryCount: 1 });
      expect(JSON.stringify(attempts)).not.toContain("durable-ags-token");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("lets instructors manually process due AGS queue attempts", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "ags-manual-instructor",
        lmsUserId: "lms-ags-manual-instructor",
        role: "instructor",
        courseId: "pact-ags-manual",
        cohortId: "cohort-a",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "ags-manual-learner",
        lmsUserId: "lms-ags-manual-learner",
        role: "learner",
        courseId: "pact-ags-manual",
        cohortId: "cohort-a",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("ags-manual-content", "cohort-a", "learner", "published", "module"),
      courseId: "pact-ags-manual",
      lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/manual-lineitem"
    });
    await db.collection("test_pactAgsContexts").insertOne({
      id: "ags-manual-context",
      courseId: "pact-ags-manual",
      cohortId: "cohort-a",
      userId: "ags-manual-instructor",
      scopes: [
        "https://purl.imsglobal.org/spec/lti-ags/scope/score",
        "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem"
      ],
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactAgsPublishAttempts").insertOne({
      id: "ags-manual-due",
      courseId: "pact-ags-manual",
      cohortId: "cohort-a",
      userId: "ags-manual-learner",
      contentId: "ags-manual-content",
      score: 8,
      maxScore: 10,
      progressPercent: 100,
      status: "pending",
      retryCount: 0,
      nextRetryAt: "2000-01-01T00:00:00.000Z",
      createdAt: now
    });
    await db.collection("test_pactAgsPublishAttempts").insertOne({
      id: "ags-manual-other-course",
      courseId: "pact-ags-other-course",
      cohortId: "cohort-a",
      userId: "ags-manual-learner",
      contentId: "ags-manual-content",
      score: 8,
      maxScore: 10,
      progressPercent: 100,
      status: "pending",
      retryCount: 0,
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: now
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "ags-manual-instructor",
      role: "instructor",
      courseId: "pact-ags-manual",
      cohortId: "cohort-a"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "manual-ags-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      const response = await request(createApp({ ...config, agsAutoRetryEnabled: true }, createLogger(config)))
        .post("/api/v1/admin/diagnostics/ags-publish-attempts/process-due")
        .set("authorization", `Bearer ${instructorToken}`)
        .expect(200);

      expect(response.body).toMatchObject({ scanned: 1, retried: 1, failed: 0, exhausted: 0 });
      await expect(db.collection("test_pactAgsPublishAttempts").findOne({ id: "ags-manual-due" }))
        .resolves.toMatchObject({ status: "published", retryCount: 1 });
      await expect(db.collection("test_pactAgsPublishAttempts").findOne({ id: "ags-manual-other-course" }))
        .resolves.toMatchObject({ status: "pending", retryCount: 0 });
      expect(JSON.stringify(await db.collection("test_pactAgsPublishAttempts").findOne({ id: "ags-manual-due" }))).not.toContain("manual-ags-token");
      await expect(db.collection("test_pactAuditEvents").findOne({
        action: "ags.queue.process_due.triggered",
        actorUserId: "ags-manual-instructor"
      })).resolves.toMatchObject({
        targetUserId: "ags-manual-instructor",
        courseId: "pact-ags-manual",
        cohortId: "cohort-a",
        metadata: {
          scanned: 1,
          retried: 1,
          failed: 0,
          exhausted: 0,
          limit: 25
        }
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("backfills already-completed PACT submissions into AGS", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "ags-backfill-instructor",
        lmsUserId: "lms-ags-backfill-instructor",
        role: "instructor",
        courseId: "pact-ags-backfill",
        cohortId: "cohort-a",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "ags-backfill-learner",
        lmsUserId: "lms-ags-backfill-learner",
        role: "learner",
        courseId: "pact-ags-backfill",
        cohortId: "cohort-a",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("ags-backfill-content", "cohort-a", "learner", "published", "module"),
      courseId: "pact-ags-backfill",
      lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/backfill-lineitem"
    });
    await db.collection("test_pactAgsContexts").insertOne({
      id: "ags-backfill-context",
      courseId: "pact-ags-backfill",
      cohortId: "cohort-a",
      userId: "ags-backfill-instructor",
      scopes: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactContentProgress").insertOne({
      id: "ags-backfill-progress",
      scope: "user",
      courseId: "pact-ags-backfill",
      cohortId: "cohort-a",
      userId: "ags-backfill-learner",
      contentId: "ags-backfill-content",
      contentType: "module",
      answers: {},
      answeredQuestionIds: [],
      progressPercent: 100,
      score: 9,
      maxScore: 10,
      status: "submitted",
      submittedAt: now,
      createdAt: now,
      updatedAt: now
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "ags-backfill-instructor",
      role: "instructor",
      courseId: "pact-ags-backfill",
      cohortId: "cohort-a"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "backfill-ags-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      const response = await request(createApp(config, createLogger(config)))
        .post("/api/v1/admin/diagnostics/ags-publish-attempts/backfill-completed")
        .set("authorization", `Bearer ${instructorToken}`)
        .expect(200);

      expect(response.body).toMatchObject({ scanned: 1, queued: 0, published: 1, skipped: 0, failed: 0 });
      await expect(db.collection("test_pactScores").findOne({
        userId: "ags-backfill-learner",
        contentId: "ags-backfill-content"
      })).resolves.toMatchObject({ score: 9, maxScore: 10, progressPercent: 100, agsStatus: "published" });
      await expect(db.collection("test_pactAgsPublishAttempts").findOne({
        userId: "ags-backfill-learner",
        contentId: "ags-backfill-content"
      })).resolves.toMatchObject({ status: "published", score: 9, maxScore: 10 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(await db.collection("test_pactAgsPublishAttempts").findOne({
        userId: "ags-backfill-learner",
        contentId: "ags-backfill-content"
      }))).not.toContain("backfill-ags-token");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("backfills previous not_applicable AGS attempts when launch context is later available", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "ags-not-applicable-instructor",
        lmsUserId: "lms-ags-not-applicable-instructor",
        role: "instructor",
        courseId: "pact-ags-not-applicable",
        cohortId: "cohort-a",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "ags-not-applicable-learner",
        lmsUserId: "lms-ags-not-applicable-learner",
        role: "learner",
        courseId: "pact-ags-not-applicable",
        cohortId: "cohort-a",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("ags-not-applicable-content", "cohort-a", "learner", "published", "module"),
      courseId: "pact-ags-not-applicable"
    });
    await db.collection("test_pactAgsContexts").insertOne({
      id: "ags-not-applicable-context",
      courseId: "pact-ags-not-applicable",
      cohortId: "cohort-a",
      userId: "ags-not-applicable-instructor",
      lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/not-applicable-lineitem",
      scopes: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactAgsPublishAttempts").insertOne({
      id: "ags-not-applicable-attempt",
      courseId: "pact-ags-not-applicable",
      cohortId: "cohort-a",
      userId: "ags-not-applicable-learner",
      contentId: "ags-not-applicable-content",
      score: 7,
      maxScore: 10,
      progressPercent: 100,
      status: "not_applicable",
      retryCount: 0,
      createdAt: now
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "ags-not-applicable-instructor",
      role: "instructor",
      courseId: "pact-ags-not-applicable",
      cohortId: "cohort-a"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "not-applicable-ags-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      const response = await request(createApp(config, createLogger(config)))
        .post("/api/v1/admin/diagnostics/ags-publish-attempts/backfill-completed")
        .set("authorization", `Bearer ${instructorToken}`)
        .expect(200);

      expect(response.body).toMatchObject({ scanned: 1, queued: 0, published: 1, skipped: 0, failed: 0 });
      await expect(db.collection("test_pactScores").findOne({
        userId: "ags-not-applicable-learner",
        contentId: "ags-not-applicable-content"
      })).resolves.toMatchObject({ score: 7, maxScore: 10, progressPercent: 100, agsStatus: "published" });
      await expect(db.collection("test_pactAgsPublishAttempts").findOne({
        userId: "ags-not-applicable-learner",
        contentId: "ags-not-applicable-content",
        status: "published"
      })).resolves.toMatchObject({
        lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/not-applicable-lineitem",
        score: 7,
        maxScore: 10
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not let stale local published score status block not_applicable AGS backfill", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "ags-stale-score-instructor",
        lmsUserId: "lms-ags-stale-score-instructor",
        role: "instructor",
        courseId: "pact-ags-stale-score",
        cohortId: "cohort-a",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "ags-stale-score-learner",
        lmsUserId: "lms-ags-stale-score-learner",
        role: "learner",
        courseId: "pact-ags-stale-score",
        cohortId: "cohort-a",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("ags-stale-score-content", "cohort-a", "learner", "published", "module"),
      courseId: "pact-ags-stale-score"
    });
    await db.collection("test_pactAgsContexts").insertOne({
      id: "ags-stale-score-context",
      courseId: "pact-ags-stale-score",
      cohortId: "cohort-a",
      userId: "ags-stale-score-instructor",
      lineItemsUrl: "http://lms.example.test/api/v1/lti/ags/lineitems",
      scopes: [
        "https://purl.imsglobal.org/spec/lti-ags/scope/score",
        "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem"
      ],
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactScores").insertOne({
      id: "ags-stale-score",
      courseId: "pact-ags-stale-score",
      cohortId: "cohort-a",
      userId: "ags-stale-score-learner",
      contentId: "ags-stale-score-content",
      contentType: "module",
      score: 6,
      maxScore: 10,
      progressPercent: 100,
      agsStatus: "published",
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactAgsPublishAttempts").insertOne({
      id: "ags-stale-score-not-applicable",
      courseId: "pact-ags-stale-score",
      cohortId: "cohort-a",
      userId: "ags-stale-score-learner",
      contentId: "ags-stale-score-content",
      score: 6,
      maxScore: 10,
      progressPercent: 100,
      status: "not_applicable",
      retryCount: 0,
      createdAt: now
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "ags-stale-score-instructor",
      role: "instructor",
      courseId: "pact-ags-stale-score",
      cohortId: "cohort-a"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "stale-score-ags-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: "stale-score-created-lineitem", label: "Day 1 Module", scoreMaximum: 10, resourceId: "ags-stale-score-content", tag: "module" }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      const response = await request(createApp(config, createLogger(config)))
        .post("/api/v1/admin/diagnostics/ags-publish-attempts/backfill-completed")
        .set("authorization", `Bearer ${instructorToken}`)
        .expect(200);

      expect(response.body).toMatchObject({ scanned: 1, queued: 0, published: 1, skipped: 0, failed: 0 });
      await expect(db.collection("test_pactAgsPublishAttempts").findOne({
        userId: "ags-stale-score-learner",
        contentId: "ags-stale-score-content",
        status: "published"
      })).resolves.toMatchObject({
        score: 6,
        maxScore: 10,
        lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/stale-score-created-lineitem"
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("backfills not_applicable AGS attempts across cohorts by default", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "ags-cross-cohort-instructor",
        lmsUserId: "lms-ags-cross-cohort-instructor",
        role: "instructor",
        courseId: "pact-ags-cross-cohort",
        cohortId: "cohort-launch",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "ags-cross-cohort-learner",
        lmsUserId: "lms-ags-cross-cohort-learner",
        role: "learner",
        courseId: "pact-ags-cross-cohort",
        cohortId: "cohort-target",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("ags-cross-cohort-content", "cohort-target", "learner", "published", "module"),
      courseId: "pact-ags-cross-cohort"
    });
    await db.collection("test_pactAgsContexts").insertOne({
      id: "ags-cross-cohort-context",
      courseId: "pact-ags-cross-cohort",
      cohortId: "cohort-launch",
      userId: "ags-cross-cohort-instructor",
      lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/cross-cohort-lineitem",
      scopes: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactAgsPublishAttempts").insertOne({
      id: "ags-cross-cohort-not-applicable",
      courseId: "pact-ags-cross-cohort",
      cohortId: "cohort-target",
      userId: "ags-cross-cohort-learner",
      contentId: "ags-cross-cohort-content",
      score: 8,
      maxScore: 10,
      progressPercent: 100,
      status: "not_applicable",
      retryCount: 0,
      createdAt: now
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "ags-cross-cohort-instructor",
      role: "instructor",
      courseId: "pact-ags-cross-cohort",
      cohortId: "cohort-launch"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "cross-cohort-ags-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      const response = await request(createApp(config, createLogger(config)))
        .post("/api/v1/admin/diagnostics/ags-publish-attempts/backfill-completed")
        .set("authorization", `Bearer ${instructorToken}`)
        .send({ limit: 10 })
        .expect(200);

      expect(response.body).toMatchObject({ scanned: 1, queued: 0, published: 1, skipped: 0, failed: 0 });
      await expect(db.collection("test_pactAgsPublishAttempts").findOne({
        userId: "ags-cross-cohort-learner",
        contentId: "ags-cross-cohort-content",
        status: "published"
      })).resolves.toMatchObject({ score: 8, maxScore: 10 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("lets external schedulers process due AGS queue attempts with a dedicated secret", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactAgsPublishAttempts").deleteMany({
      status: { $in: ["pending", "failed"] },
      nextRetryAt: { $lte: now }
    });
    await db.collection("test_pactUsers").insertOne({
      id: "ags-scheduler-learner",
      lmsUserId: "lms-ags-scheduler-learner",
      role: "learner",
      courseId: "pact-ags-scheduler",
      cohortId: "cohort-a",
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("ags-scheduler-content", "cohort-a", "learner", "published", "module"),
      courseId: "pact-ags-scheduler",
      lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/scheduler-lineitem"
    });
    await db.collection("test_pactAgsContexts").insertOne({
      id: "ags-scheduler-context",
      courseId: "pact-ags-scheduler",
      cohortId: "cohort-a",
      userId: "ags-scheduler-learner",
      scopes: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactAgsPublishAttempts").insertOne({
      id: "ags-scheduler-due",
      courseId: "pact-ags-scheduler",
      cohortId: "cohort-a",
      userId: "ags-scheduler-learner",
      contentId: "ags-scheduler-content",
      score: 8,
      maxScore: 10,
      progressPercent: 100,
      status: "pending",
      retryCount: 0,
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: now
    });
    const schedulerConfig = {
      ...config,
      agsProcessDueSchedulerSecret: "scheduler-secret-with-enough-length"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "scheduler-ags-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      await request(createApp(schedulerConfig, createLogger(config)))
        .post("/api/v1/ops/ags-publish-attempts/process-due")
        .set("authorization", "Bearer wrong-secret")
        .send({ limit: 10 })
        .expect(401);

      const response = await request(createApp(schedulerConfig, createLogger(config)))
        .post("/api/v1/ops/ags-publish-attempts/process-due")
        .set("authorization", "Bearer scheduler-secret-with-enough-length")
        .send({ limit: 1 })
        .expect(200);

      expect(response.body).toMatchObject({ scanned: 1, retried: 1, failed: 0, exhausted: 0 });
      await expect(db.collection("test_pactAgsPublishAttempts").findOne({ id: "ags-scheduler-due" }))
        .resolves.toMatchObject({ status: "published", retryCount: 1 });
      expect(JSON.stringify(await db.collection("test_pactAgsPublishAttempts").findOne({ id: "ags-scheduler-due" }))).not.toContain("scheduler-ags-token");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("marks durable AGS retries as exhausted when max attempts is reached", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertOne({
      id: "ags-exhausted-learner",
      lmsUserId: "lms-ags-exhausted-learner",
      role: "learner",
      courseId: "pact-ags-exhausted",
      cohortId: "cohort-a",
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("ags-exhausted-content", "cohort-a", "learner", "published", "module"),
      courseId: "pact-ags-exhausted",
      lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/exhausted-lineitem"
    });
    await db.collection("test_pactAgsContexts").insertOne({
      id: "ags-exhausted-context",
      courseId: "pact-ags-exhausted",
      cohortId: "cohort-a",
      userId: "ags-exhausted-operator",
      lineItemsUrl: "http://lms.example.test/api/v1/lti/ags/lineitems",
      scopes: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactAgsPublishAttempts").insertOne({
      id: "ags-exhausted-due",
      courseId: "pact-ags-exhausted",
      cohortId: "cohort-a",
      userId: "ags-exhausted-learner",
      contentId: "ags-exhausted-content",
      score: 9,
      maxScore: 10,
      progressPercent: 100,
      status: "failed",
      retryCount: 1,
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: now
    });
    const retryConfig = { ...config, agsAutoRetryEnabled: true, agsAutoRetryMaxAttempts: 2 };
    const repository = new PactRepository(db, retryConfig);
    const service = new AgsMaintenanceService(
      retryConfig,
      repository,
      new PactService(repository, new LmsAgsClient(), new LmsTokenClient(retryConfig), retryConfig),
      createLogger(retryConfig)
    );
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "exhausted-ags-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ error: "temporarily_unavailable" }, 503));

    try {
      const result = await service.retryDueAgsAttempts();

      expect(result.exhausted).toBeGreaterThanOrEqual(1);
      const attempts = await db.collection("test_pactAgsPublishAttempts")
        .find({ courseId: "pact-ags-exhausted", contentId: "ags-exhausted-content" })
        .sort({ createdAt: 1 })
        .toArray();
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ status: "retry_exhausted", retryCount: 2 });
      expect(attempts[0].nextRetryAt).toBeUndefined();
      expect(JSON.stringify(attempts)).not.toContain("exhausted-ags-token");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("notifies configured sinks when durable AGS retries exhaust", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertOne({
      id: "ags-notify-learner",
      lmsUserId: "lms-ags-notify-learner",
      role: "learner",
      courseId: "pact-ags-notify",
      cohortId: "cohort-a",
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("ags-notify-content", "cohort-a", "learner", "published", "module"),
      courseId: "pact-ags-notify",
      lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/notify-lineitem"
    });
    await db.collection("test_pactAgsContexts").insertOne({
      id: "ags-notify-context",
      courseId: "pact-ags-notify",
      cohortId: "cohort-a",
      userId: "ags-notify-operator",
      scopes: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactAgsPublishAttempts").insertOne({
      id: "ags-notify-due",
      courseId: "pact-ags-notify",
      cohortId: "cohort-a",
      userId: "ags-notify-learner",
      contentId: "ags-notify-content",
      score: 9,
      maxScore: 10,
      progressPercent: 100,
      status: "failed",
      retryCount: 1,
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: now
    });
    const retryConfig = {
      ...config,
      agsAutoRetryEnabled: true,
      agsAutoRetryMaxAttempts: 2,
      agsRetryExhaustedWebhookUrls: ["https://ops.example.test/ags-exhausted"],
      agsRetryExhaustedWebhookBearerToken: "sink-token"
    };
    const repository = new PactRepository(db, retryConfig);
    const service = new AgsMaintenanceService(
      retryConfig,
      repository,
      new PactService(repository, new LmsAgsClient(), new LmsTokenClient(retryConfig), retryConfig),
      createLogger(retryConfig)
    );
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "notify-ags-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ error: "temporarily_unavailable" }, 503))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      const result = await service.retryDueAgsAttempts();

      expect(result.exhausted).toBeGreaterThanOrEqual(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ops.example.test/ags-exhausted",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ authorization: "Bearer sink-token" }),
          body: expect.stringContaining("\"event\":\"ags.retry_exhausted\"")
        })
      );
      expect(String(fetchMock.mock.calls[2]?.[1]?.body)).not.toContain("notify-ags-token");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("dead-letters exhausted retry notifications after sink delivery retries fail", async () => {
    const db = await getMongoDb(config);
    const retryConfig = {
      ...config,
      agsRetryExhaustedWebhookUrls: ["https://ops.example.test/ags-exhausted"],
      agsRetryExhaustedWebhookMaxAttempts: 2,
      agsRetryExhaustedWebhookInitialDelayMs: 1000,
      agsRetryExhaustedWebhookMaxDelayMs: 1000
    };
    const repository = new PactRepository(db, retryConfig);
    const service = new AgsMaintenanceService(
      retryConfig,
      repository,
      new PactService(repository, new LmsAgsClient(), new LmsTokenClient(retryConfig), retryConfig),
      createLogger(retryConfig)
    );
    const notification = await repository.enqueueNotification({
      event: "ags.retry_exhausted",
      sinkUrl: "https://ops.example.test/ags-exhausted",
      payload: { event: "ags.retry_exhausted", exhausted: 1 }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 503 }));

    try {
      await expect(service.deliverDueNotifications()).resolves.toMatchObject({ scanned: 1, failed: 1, deadLettered: 0 });
      await db.collection("test_pactNotifications").updateOne(
        { id: notification.id },
        { $set: { nextAttemptAt: new Date(Date.now() - 1000).toISOString() } }
      );
      await expect(service.deliverDueNotifications()).resolves.toMatchObject({ scanned: 1, failed: 1, deadLettered: 1 });

      await expect(db.collection("test_pactNotifications").findOne({ id: notification.id })).resolves.toMatchObject({
        status: "dead_letter",
        attemptCount: 2,
        lastStatus: 503
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("lists dead-lettered notification diagnostics for operators", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactNotifications").insertOne({
      id: "notification-dead-letter",
      event: "ags.retry_exhausted",
      sinkUrl: "https://ops.example.test/ags-exhausted",
      payload: { event: "ags.retry_exhausted", exhausted: 1 },
      status: "dead_letter",
      attemptCount: 5,
      nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
      lastStatus: 503,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "operator-notifications",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-a"
    });

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/diagnostics/notifications?status=dead_letter")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "notification-dead-letter",
        event: "ags.retry_exhausted",
        status: "dead_letter",
        attemptCount: 5,
        lastStatus: 503
      })
    ]));
    expect(JSON.stringify(response.body.notifications)).not.toContain("Bearer");
  });

  it("cleans up AGS publish attempts older than the retention window", async () => {
    const db = await getMongoDb(config);
    const oldDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date().toISOString();
    await db.collection("test_pactAgsPublishAttempts").insertMany([
      {
        id: "ags-retention-old",
        courseId: "pact-retention",
        cohortId: "cohort-a",
        userId: "user-1",
        contentId: "content-1",
        score: 1,
        maxScore: 10,
        progressPercent: 100,
        status: "failed",
        createdAt: oldDate
      },
      {
        id: "ags-retention-recent",
        courseId: "pact-retention",
        cohortId: "cohort-a",
        userId: "user-1",
        contentId: "content-1",
        score: 2,
        maxScore: 10,
        progressPercent: 100,
        status: "failed",
        createdAt: recentDate
      }
    ]);

    const service = new AgsMaintenanceService(
      { ...config, agsAttemptRetentionDays: 90 },
      new PactRepository(db, config),
      new PactService(new PactRepository(db, config), new LmsAgsClient(), new LmsTokenClient(config), config),
      createLogger(config)
    );
    const deletedCount = await service.cleanupOldAttempts();

    expect(deletedCount).toBeGreaterThanOrEqual(1);
    expect(await db.collection("test_pactAgsPublishAttempts").findOne({ id: "ags-retention-old" })).toBeNull();
    expect(await db.collection("test_pactAgsPublishAttempts").findOne({ id: "ags-retention-recent" })).toMatchObject({
      id: "ags-retention-recent"
    });
  });

  it("returns course-scoped AGS publish attempt diagnostics to admins and instructors", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactAgsPublishAttempts").insertMany([
      {
        id: "ags-diag-failed",
        courseId: "pact-ags-diag",
        cohortId: "cohort-a",
        squadId: "squad-1",
        userId: "user-1",
        contentId: "content-1",
        lineItemUrl: "http://lms.example.test/lineitems/1",
        score: 8,
        maxScore: 10,
        progressPercent: 100,
        status: "failed",
        errorCode: "AGS_PUBLISH_FAILED",
        errorMessage: "LMS AGS score publish failed",
        createdAt: now
      },
      {
        id: "ags-diag-published",
        courseId: "pact-ags-diag",
        cohortId: "cohort-a",
        userId: "user-1",
        contentId: "content-1",
        score: 9,
        maxScore: 10,
        progressPercent: 100,
        status: "published",
        createdAt: now
      },
      {
        id: "ags-diag-other-course",
        courseId: "other-course",
        cohortId: "cohort-a",
        userId: "user-1",
        contentId: "content-1",
        score: 10,
        maxScore: 10,
        progressPercent: 100,
        status: "failed",
        errorCode: "SHOULD_NOT_LEAK",
        createdAt: now
      }
    ]);
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "instructor-visible",
      role: "instructor",
      courseId: "pact-ags-diag",
      cohortId: "cohort-a"
    });
    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact-ags-diag",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });

    await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/diagnostics/ags-publish-attempts")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(403);

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/diagnostics/ags-publish-attempts?status=failed")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);

    expect(response.body.attempts).toEqual([
      expect.objectContaining({
        id: "ags-diag-failed",
        courseId: "pact-ags-diag",
        status: "failed",
        errorCode: "AGS_PUBLISH_FAILED"
      })
    ]);
    expect(response.body.nextCursor).toBeUndefined();
    expect(response.body.summary).toMatchObject({
      total: 1,
      byStatus: { failed: 1 }
    });
    expect(JSON.stringify(response.body)).not.toContain("SHOULD_NOT_LEAK");
    expect(JSON.stringify(response.body).toLowerCase()).not.toContain("token");

    const pagedResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/diagnostics/ags-publish-attempts?limit=1")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);
    expect(pagedResponse.body.attempts).toHaveLength(1);
    expect(pagedResponse.body.nextCursor).toEqual(expect.any(String));

    const exportResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/diagnostics/ags-publish-attempts/export.csv?status=failed")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);
    expect(exportResponse.headers["content-type"]).toContain("text/csv");
    expect(exportResponse.text).toContain("ags-diag-failed");
    expect(exportResponse.text).not.toContain("SHOULD_NOT_LEAK");
  });

  it("lets instructors retry course-scoped failed AGS publish attempts without persisting tokens", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertOne({
      id: "ags-retry-learner",
      lmsUserId: "lms-ags-retry-learner",
      role: "learner",
      courseId: "pact-ags-retry",
      cohortId: "cohort-a",
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactContent").insertOne({
      ...publishedContent("ags-retry-content", "cohort-a", "learner", "published", "module"),
      courseId: "pact-ags-retry",
      lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/retry-1"
    });
    await db.collection("test_pactAgsPublishAttempts").insertMany([
      {
        id: "ags-retry-failed",
        courseId: "pact-ags-retry",
        cohortId: "cohort-a",
        userId: "ags-retry-learner",
        contentId: "ags-retry-content",
        lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/retry-1",
        score: 6,
        maxScore: 10,
        progressPercent: 100,
        status: "failed",
        errorCode: "AGS_PUBLISH_FAILED",
        createdAt: now
      },
      {
        id: "ags-retry-other-course",
        courseId: "other-course",
        cohortId: "cohort-a",
        userId: "ags-retry-learner",
        contentId: "ags-retry-content",
        score: 10,
        maxScore: 10,
        progressPercent: 100,
        status: "failed",
        errorCode: "SHOULD_NOT_LEAK",
        createdAt: now
      }
    ]);
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "ags-retry-instructor",
      role: "instructor",
      courseId: "pact-ags-retry",
      cohortId: "cohort-a"
    });
    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "ags-retry-learner",
      role: "learner",
      courseId: "pact-ags-retry",
      cohortId: "cohort-a"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    try {
      await request(createApp(config, createLogger(config)))
        .post("/api/v1/admin/diagnostics/ags-publish-attempts/ags-retry-failed/retry")
        .set("authorization", `Bearer ${learnerToken}`)
        .send({ agsAccessToken: "retry-token" })
        .expect(403);

      await request(createApp(config, createLogger(config)))
        .post("/api/v1/admin/diagnostics/ags-publish-attempts/ags-retry-other-course/retry")
        .set("authorization", `Bearer ${instructorToken}`)
        .send({ agsAccessToken: "retry-token" })
        .expect(404);

      const response = await request(createApp(config, createLogger(config)))
        .post("/api/v1/admin/diagnostics/ags-publish-attempts/ags-retry-failed/retry")
        .set("authorization", `Bearer ${instructorToken}`)
        .send({ agsAccessToken: "retry-token" })
        .expect(200);

      expect(response.body).toMatchObject({
        agsStatus: "published",
        score: {
          userId: "ags-retry-learner",
          contentId: "ags-retry-content",
          score: 6,
          maxScore: 10,
          progressPercent: 100,
          agsStatus: "published"
        }
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://lms.example.test/api/v1/lti/ags/lineitems/retry-1/scores",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer retry-token" })
        })
      );

      const attempts = await db.collection("test_pactAgsPublishAttempts")
        .find({ courseId: "pact-ags-retry", contentId: "ags-retry-content" })
        .sort({ createdAt: 1 })
        .toArray();
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ status: "published" });
      expect(JSON.stringify(attempts)).not.toContain("retry-token");
      expect(JSON.stringify(response.body)).not.toContain("retry-token");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects AGS retry attempts that are already final", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactAgsPublishAttempts").insertOne({
      id: "ags-retry-published",
      courseId: "pact-ags-retry",
      cohortId: "cohort-a",
      userId: "ags-retry-learner",
      contentId: "ags-retry-content",
      score: 6,
      maxScore: 10,
      progressPercent: 100,
      status: "published",
      createdAt: now
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "ags-retry-instructor",
      role: "instructor",
      courseId: "pact-ags-retry",
      cohortId: "cohort-a"
    });

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/admin/diagnostics/ags-publish-attempts/ags-retry-published/retry")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ agsAccessToken: "retry-token" })
      .expect(409);
  });

  it("persists learner content progress separately from score submission", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactContent").updateOne(
      { id: "progress-content" },
      {
        $set: {
          ...publishedContent("progress-content", "cohort-a", "learner", "published", "module"),
          questionCount: 2,
          questions: [
            { id: "progress-q1", scoring: { points: 5, difficulty: "easy", mustPass: false } },
            { id: "progress-q2", scoring: { points: 5, difficulty: "easy", mustPass: false } }
          ]
        }
      },
      { upsert: true }
    );
    await db.collection("test_pactContent").updateOne(
      { id: "progress-game" },
      { $set: { ...publishedContent("progress-game", "cohort-a", "learner", "published", "game") } },
      { upsert: true }
    );
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });

    const progressResponse = await request(createApp(config, createLogger(config)))
      .patch("/api/v1/content/progress-content/progress")
      .set("authorization", `Bearer ${token}`)
      .send({
        answers: {
          "progress-q1": "selected-option",
          "unknown-question": "ignored"
        }
      })
      .expect(200);

    expect(progressResponse.body).toMatchObject({
      userId: "user-1",
      contentId: "progress-content",
      status: "in_progress",
      progressPercent: 50,
      answeredQuestionIds: ["progress-q1"],
      answers: { "progress-q1": "selected-option" }
    });
    expect(JSON.stringify(progressResponse.body)).not.toContain("unknown-question");

    const gameProgressResponse = await request(createApp(config, createLogger(config)))
      .patch("/api/v1/content/progress-game/progress")
      .set("authorization", `Bearer ${token}`)
      .send({
        mechanicsState: {
          kind: "packet_capture",
          capturedNodeIds: ["dns"]
        },
        progressPercent: 50,
        status: "in_progress"
      })
      .expect(200);

    expect(gameProgressResponse.body).toMatchObject({
      userId: "user-1",
      contentId: "progress-game",
      status: "in_progress",
      progressPercent: 50,
      mechanicsState: { kind: "packet_capture", capturedNodeIds: ["dns"] }
    });

    const listResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content/progress")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    expect(listResponse.body.progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ contentId: "progress-content", progressPercent: 50 }),
      expect.objectContaining({ contentId: "progress-game", progressPercent: 50, mechanicsState: { kind: "packet_capture", capturedNodeIds: ["dns"] } })
    ]));

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/scores")
      .set("authorization", `Bearer ${token}`)
      .send({ contentId: "progress-content", score: 10, maxScore: 10, progressPercent: 100 })
      .expect(201);

    const submitted = await db.collection("test_pactContentProgress").findOne({ userId: "user-1", contentId: "progress-content" });
    expect(submitted).toMatchObject({
      status: "submitted",
      score: 10,
      maxScore: 10,
      progressPercent: 100
    });
  });

  it("persists challenge and workshop progress as one shared squad record", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "squad-progress-a",
        lmsUserId: "lms-squad-progress-a",
        role: "learner",
        courseId: "pact",
        cohortId: "cohort-squad-progress",
        squadId: "squad-progress-1",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "squad-progress-b",
        lmsUserId: "lms-squad-progress-b",
        role: "learner",
        courseId: "pact",
        cohortId: "cohort-squad-progress",
        squadId: "squad-progress-1",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "squad-progress-unassigned",
        lmsUserId: "lms-squad-progress-unassigned",
        role: "learner",
        courseId: "pact",
        cohortId: "cohort-squad-progress",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactContent").insertMany([
      {
        ...publishedContent("squad-progress-challenge", "cohort-squad-progress", "learner", "published", "challenge"),
        mechanics: {
          kind: "challenge_path",
          title: "Squad challenge",
          prompt: "Complete together.",
          synthesisPrompts: [{ id: "summary", label: "Summary", prompt: "What happened?", required: true }],
          paths: [{ id: "contain", label: "Contain", detail: "Contain the incident.", score: 10 }]
        }
      },
      publishedContent("squad-progress-workshop", "cohort-squad-progress", "learner", "published", "workshop"),
      publishedContent("squad-progress-module", "cohort-squad-progress", "learner", "published", "module")
    ]);
    const learnerAToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "squad-progress-a",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-squad-progress",
      squadId: "squad-progress-1"
    });
    const learnerBToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "squad-progress-b",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-squad-progress",
      squadId: "squad-progress-1"
    });
    const unassignedToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "squad-progress-unassigned",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-squad-progress"
    });

    const challengeProgress = await request(createApp(config, createLogger(config)))
      .patch("/api/v1/content/squad-progress-challenge/squad-progress")
      .set("authorization", `Bearer ${learnerAToken}`)
      .send({
        mechanicsState: {
          synthesisResponses: { summary: "Shared answer" }
        },
        progressPercent: 60,
        status: "in_progress"
      })
      .expect(200);

    expect(challengeProgress.body).toMatchObject({
      scope: "squad",
      userId: "squad:squad-progress-1",
      updatedByUserId: "squad-progress-a",
      squadId: "squad-progress-1",
      contentId: "squad-progress-challenge",
      contentType: "challenge",
      progressPercent: 60,
      status: "in_progress",
      mechanicsState: { synthesisResponses: { summary: "Shared answer" } }
    });

    const sharedProgress = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content/squad-progress-challenge/squad-progress")
      .set("authorization", `Bearer ${learnerBToken}`)
      .expect(200);

    expect(sharedProgress.body.progress).toMatchObject({
      id: challengeProgress.body.id,
      scope: "squad",
      squadId: "squad-progress-1",
      contentId: "squad-progress-challenge",
      mechanicsState: { synthesisResponses: { summary: "Shared answer" } }
    });

    const workshopScore = await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/squad-progress-workshop/squad-score")
      .set("authorization", `Bearer ${learnerBToken}`)
      .send({ score: 9, maxScore: 10, progressPercent: 100 })
      .expect(201);

    expect(workshopScore.body).toMatchObject({
      scope: "squad",
      updatedByUserId: "squad-progress-b",
      squadId: "squad-progress-1",
      contentId: "squad-progress-workshop",
      contentType: "workshop",
      status: "submitted",
      score: 9,
      maxScore: 10,
      progressPercent: 100,
      agsStatus: "not_applicable"
    });

    const squadProgressRecords = await db.collection("test_pactContentProgress")
      .find({ scope: "squad", squadId: "squad-progress-1" })
      .toArray();
    expect(squadProgressRecords).toHaveLength(2);
    const memberScores = await db.collection("test_pactScores")
      .find({ contentId: "squad-progress-workshop" })
      .sort({ userId: 1 })
      .toArray();
    expect(memberScores).toHaveLength(2);
    expect(memberScores.map((score) => score.userId)).toEqual(["squad-progress-a", "squad-progress-b"]);
    expect(memberScores.every((score) => score.agsStatus === "not_applicable")).toBe(true);

    const listResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content/squad-progress")
      .set("authorization", `Bearer ${learnerAToken}`)
      .expect(200);
    expect(listResponse.body.progress.map((item: { contentId: string }) => item.contentId).sort()).toEqual([
      "squad-progress-challenge",
      "squad-progress-workshop"
    ]);

    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/content/squad-progress-module/squad-progress")
      .set("authorization", `Bearer ${learnerAToken}`)
      .send({ progressPercent: 100, status: "submitted" })
      .expect(400);

    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/content/squad-progress-challenge/squad-progress")
      .set("authorization", `Bearer ${unassignedToken}`)
      .send({ progressPercent: 100, status: "submitted" })
      .expect(409);
  });

  it("records per-question attempts and exposes instructor review without LMS user IDs", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactContent").updateOne(
      { id: "attempt-content" },
      {
        $set: {
          ...publishedContent("attempt-content", "cohort-a", "learner", "published", "module"),
          questionCount: 1,
          questions: [
            {
              id: "attempt-q1",
              version: 2,
              topic: "Triage",
              payload: {
                kind: "multiple_choice",
                selectionMode: "single",
                correct: ["b"]
              },
              feedback: {
                correct: { en: "Correct path." },
                incorrect: { en: "Review the triage path." },
                reference: "PACT-REF-1"
              },
              scoring: { points: 5, difficulty: "easy", mustPass: false }
            }
          ]
        }
      },
      { upsert: true }
    );
    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "instructor-1",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-a"
    });

    const firstAttempt = await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/attempt-content/questions/attempt-q1/attempts")
      .set("authorization", `Bearer ${learnerToken}`)
      .send({ answer: "a", feedbackExposed: true })
      .expect(201);

    expect(firstAttempt.body.attempt).toMatchObject({
      userId: "user-1",
      contentId: "attempt-content",
      questionId: "attempt-q1",
      questionVersion: 2,
      attemptNumber: 1,
      answer: "a",
      score: 0,
      maxScore: 5,
      isCorrect: false,
      feedbackExposed: true,
      feedbackExposedAt: expect.any(String),
      submittedAt: expect.any(String)
    });
    expect(firstAttempt.body.progress).toMatchObject({
      contentId: "attempt-content",
      progressPercent: 100,
      answeredQuestionIds: ["attempt-q1"],
      answers: { "attempt-q1": "a" }
    });

    const secondAttempt = await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/attempt-content/questions/attempt-q1/attempts")
      .set("authorization", `Bearer ${learnerToken}`)
      .send({ answer: "b", feedbackExposed: true })
      .expect(201);

    expect(secondAttempt.body.attempt).toMatchObject({
      attemptNumber: 2,
      answer: "b",
      score: 5,
      isCorrect: true
    });

    await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/analytics/question-attempts")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(403);

    const reviewResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/analytics/question-attempts?cohortId=cohort-a&contentId=attempt-content")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);

    expect(reviewResponse.body.attempts).toEqual([
      expect.objectContaining({
        userId: "user-1",
        contentId: "attempt-content",
        contentTitle: "attempt-content",
        questionId: "attempt-q1",
        questionTopic: "Triage",
        attemptNumber: 2,
        answer: "b",
        score: 5,
        isCorrect: true,
        feedbackExposed: true
      }),
      expect.objectContaining({
        attemptNumber: 1,
        answer: "a",
        score: 0,
        isCorrect: false
      })
    ]);
    expect(JSON.stringify(reviewResponse.body)).not.toContain("lms-user-1");
  });

  it("scores question submissions immediately and publishes AGS when content is complete", async () => {
    const db = await getMongoDb(config);
    const idToken = await signResourceLaunch({
      ags: {
        lineitems: "http://lms.example.test/api/v1/lti/ags/lineitems",
        lineitem: "http://lms.example.test/api/v1/lti/ags/lineitems/completion-gated",
        scope: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"]
      }
    });
    const launchResponse = await request(createApp(config, createLogger(config)))
      .post("/launch/module")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: idToken })
      .expect(200);
    await db.collection("test_pactContent").updateOne(
      { id: "completion-gated-attempt-content" },
      {
        $set: {
          ...publishedContent("completion-gated-attempt-content", "cohort-launch", "learner", "published", "module"),
          questionCount: 2,
          questions: [
            {
              id: "completion-q1",
              version: 1,
              topic: "First",
              payload: { kind: "true_false", correct: true },
              feedback: { correct: { en: "Right." }, incorrect: { en: "Try again." } },
              scoring: { points: 4, difficulty: "easy", mustPass: false }
            },
            {
              id: "completion-q2",
              version: 1,
              topic: "Second",
              payload: { kind: "multiple_choice", correct: ["b"] },
              feedback: { correct: { en: "Good choice." }, incorrect: { en: "Review the scenario." } },
              scoring: { points: 6, difficulty: "easy", mustPass: false }
            }
          ]
        }
      },
      { upsert: true }
    );
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: launchResponse.body.user.id,
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-launch",
      contentType: "module"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "completion-ags-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      const firstAttempt = await request(createApp(config, createLogger(config)))
        .post("/api/v1/content/completion-gated-attempt-content/questions/completion-q1/attempts")
        .set("authorization", `Bearer ${token}`)
        .send({ answer: true, feedbackExposed: true })
        .expect(201);

      expect(firstAttempt.body.feedback).toMatchObject({
        submissionId: "completion-q1",
        status: "correct",
        earnedPoints: 4,
        possiblePoints: 4,
        feedback: { en: "Right." }
      });
      expect(firstAttempt.body.progress).toMatchObject({
        contentId: "completion-gated-attempt-content",
        status: "in_progress",
        progressPercent: 50
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await db.collection("test_pactScores").findOne({
        userId: launchResponse.body.user.id,
        contentId: "completion-gated-attempt-content"
      })).toBeNull();

      const secondAttempt = await request(createApp(config, createLogger(config)))
        .post("/api/v1/content/completion-gated-attempt-content/questions/completion-q2/attempts")
        .set("authorization", `Bearer ${token}`)
        .send({ answer: ["b"], feedbackExposed: true })
        .expect(201);

      expect(secondAttempt.body.score).toMatchObject({
        userId: launchResponse.body.user.id,
        contentId: "completion-gated-attempt-content",
        score: 10,
        maxScore: 10,
        progressPercent: 100,
        agsStatus: "published"
      });
      expect(secondAttempt.body.progress).toMatchObject({
        status: "submitted",
        score: 10,
        maxScore: 10,
        progressPercent: 100
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://lms.example.test/api/v1/lti/ags/lineitems/completion-gated/scores",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer completion-ags-token" })
        })
      );
      const completionStatus = await request(createApp(config, createLogger(config)))
        .get("/api/v1/content/completion-gated-attempt-content/completion")
        .set("authorization", `Bearer ${token}`)
        .expect(200);

      expect(completionStatus.body.completion).toMatchObject({
        complete: true,
        status: "complete",
        score: 10,
        maxScore: 10
      });
      expect(completionStatus.body.score).toMatchObject({ agsStatus: "published" });

      const queuedAttempts = await db.collection("test_pactAgsPublishAttempts")
        .find({ contentId: "completion-gated-attempt-content", userId: launchResponse.body.user.id })
        .toArray();
      expect(queuedAttempts).toHaveLength(1);
      expect(queuedAttempts[0]).toMatchObject({
        status: "published",
        score: 10,
        maxScore: 10,
        lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/completion-gated"
      });
      expect(JSON.stringify(queuedAttempts)).not.toContain("completion-ags-token");
      await expect(db.collection("test_pactScores").findOne({
        userId: launchResponse.body.user.id,
        contentId: "completion-gated-attempt-content"
      })).resolves.toMatchObject({ agsStatus: "published" });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uses assignment policy for optional questions, attempt limits, manual grading, and must-pass gates", async () => {
    const db = await getMongoDb(config);
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "policy-instructor",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-a"
    });

    await db.collection("test_pactContent").insertMany([
      {
        ...publishedContent("policy-optional-content", "cohort-a", "learner", "published", "module"),
        questionCount: 2,
        questions: [
          policyQuestion("policy-required-q1", { kind: "true_false", correct: true }, { points: 4 }),
          policyQuestion("policy-optional-q2", { kind: "true_false", correct: true }, { points: 6, optional: true })
        ]
      },
      {
        ...publishedContent("policy-limit-content", "cohort-a", "learner", "published", "module"),
        questionCount: 1,
        questions: [
          policyQuestion("policy-limit-q1", { kind: "true_false", correct: true }, { points: 5, maxAttempts: 1 })
        ]
      },
      {
        ...publishedContent("policy-manual-content", "cohort-a", "learner", "published", "module"),
        questionCount: 1,
        questions: [
          policyQuestion("policy-manual-q1", { kind: "manual_review" }, { points: 10, gradingMode: "manual" })
        ]
      },
      {
        ...publishedContent("policy-must-pass-content", "cohort-a", "learner", "published", "module"),
        questionCount: 2,
        questions: [
          policyQuestion("policy-must-pass-q1", { kind: "true_false", correct: true }, { points: 5, mustPass: true }),
          policyQuestion("policy-must-pass-q2", { kind: "true_false", correct: true }, { points: 5 })
        ]
      }
    ]);

    const optionalResponse = await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/policy-optional-content/questions/policy-required-q1/attempts")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: true, feedbackExposed: true })
      .expect(201);

    expect(optionalResponse.body.score).toMatchObject({
      contentId: "policy-optional-content",
      score: 4,
      maxScore: 4,
      progressPercent: 100,
      agsStatus: "not_applicable"
    });
    expect(optionalResponse.body.completion).toMatchObject({
      complete: true,
      status: "complete",
      requiredQuestionIds: ["policy-required-q1"]
    });

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/policy-limit-content/questions/policy-limit-q1/attempts")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: false, feedbackExposed: true })
      .expect(201);

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/policy-limit-content/questions/policy-limit-q1/attempts")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: true, feedbackExposed: true })
      .expect(409);

    const manualResponse = await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/policy-manual-content/questions/policy-manual-q1/attempts")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: "Needs instructor review", feedbackExposed: true })
      .expect(201);

    expect(manualResponse.body.feedback).toMatchObject({
      status: "needs_review",
      earnedPoints: 0,
      possiblePoints: 10
    });
    expect(manualResponse.body.completion).toMatchObject({
      complete: false,
      status: "pending_manual",
      pendingManualQuestionIds: ["policy-manual-q1"]
    });
    expect(manualResponse.body.score).toBeUndefined();

    await request(createApp(config, createLogger(config)))
      .post(`/api/v1/admin/analytics/question-attempts/${manualResponse.body.attempt.id}/grade`)
      .set("authorization", `Bearer ${token}`)
      .send({ score: 9, feedback: "Strong response." })
      .expect(403);

    const pendingManualAttemptsResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/analytics/question-attempts?cohortId=cohort-a&contentId=policy-manual-content&manualGradingStatus=pending")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);

    expect(pendingManualAttemptsResponse.body.attempts).toEqual([
      expect.objectContaining({
        id: manualResponse.body.attempt.id,
        manualGradingStatus: "pending"
      })
    ]);

    const gradeResponse = await request(createApp(config, createLogger(config)))
      .post(`/api/v1/admin/analytics/question-attempts/${manualResponse.body.attempt.id}/grade`)
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ score: 9, feedback: "Strong response." })
      .expect(200);

    expect(gradeResponse.body.grade).toMatchObject({
      attemptId: manualResponse.body.attempt.id,
      score: 9,
      maxScore: 10,
      isCorrect: false,
      feedback: "Strong response.",
      gradedByUserId: "policy-instructor"
    });
    expect(gradeResponse.body.completion).toMatchObject({
      complete: true,
      status: "complete",
      pendingManualQuestionIds: []
    });
    expect(gradeResponse.body.score).toMatchObject({
      contentId: "policy-manual-content",
      score: 9,
      maxScore: 10,
      progressPercent: 100,
      agsStatus: "not_applicable"
    });

    const gradedAttemptsResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/analytics/question-attempts?cohortId=cohort-a&contentId=policy-manual-content")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);

    expect(gradedAttemptsResponse.body.attempts[0]).toMatchObject({
      id: manualResponse.body.attempt.id,
      questionId: "policy-manual-q1",
      manualGradingStatus: "graded",
      manualGrade: {
        score: 9,
        maxScore: 10,
        isCorrect: false,
        feedback: "Strong response.",
        gradedByUserId: "policy-instructor",
        gradedAt: expect.any(String)
      }
    });

    const manualAuditEvent = await db.collection("test_pactAuditEvents").findOne({
      action: "question.manual_grade.upserted",
      actorUserId: "policy-instructor",
      targetUserId: "user-1",
      "metadata.attemptId": manualResponse.body.attempt.id
    });
    expect(manualAuditEvent).toMatchObject({
      courseId: "pact",
      cohortId: "cohort-a",
      metadata: {
        contentId: "policy-manual-content",
        questionId: "policy-manual-q1",
        nextScore: 9,
        maxScore: 10,
        nextIsCorrect: false,
        feedbackChanged: true
      }
    });

    const gradedManualAttemptsResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/analytics/question-attempts?cohortId=cohort-a&contentId=policy-manual-content&manualGradingStatus=graded")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);

    expect(gradedManualAttemptsResponse.body.attempts).toEqual([
      expect.objectContaining({
        id: manualResponse.body.attempt.id,
        manualGradingStatus: "graded"
      })
    ]);

    await request(createApp(config, createLogger(config)))
      .post(`/api/v1/admin/analytics/question-attempts/${manualResponse.body.attempt.id}/grade`)
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ score: 11 })
      .expect(400);

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/policy-must-pass-content/questions/policy-must-pass-q1/attempts")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: false, feedbackExposed: true })
      .expect(201);
    const mustPassResponse = await request(createApp(config, createLogger(config)))
      .post("/api/v1/content/policy-must-pass-content/questions/policy-must-pass-q2/attempts")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: true, feedbackExposed: true })
      .expect(201);

    expect(mustPassResponse.body.completion).toMatchObject({
      complete: false,
      status: "failed_must_pass",
      failedMustPassQuestionIds: ["policy-must-pass-q1"]
    });
    expect(mustPassResponse.body.score).toBeUndefined();
  });

  it("returns instructor cohort progress analytics without exposing LMS user IDs", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "analytics-instructor",
        lmsUserId: "lms-analytics-instructor",
        role: "instructor",
        courseId: "pact-analytics",
        cohortId: "cohort-analytics-a",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "analytics-learner-a",
        lmsUserId: "lms-analytics-learner-a",
        name: "Analytics Learner A",
        role: "learner",
        courseId: "pact-analytics",
        cohortId: "cohort-analytics-a",
        squadId: "analytics-squad-1",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "analytics-learner-b",
        lmsUserId: "lms-analytics-learner-b",
        name: "Analytics Learner B",
        role: "learner",
        courseId: "pact-analytics",
        cohortId: "cohort-analytics-b",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await db.collection("test_pactSquads").insertOne({
      id: "analytics-squad-1",
      courseId: "pact-analytics",
      cohortId: "cohort-analytics-a",
      name: "Squad 1",
      number: "1",
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactContent").insertMany([
      { ...publishedContent("analytics-content-a", "cohort-analytics-a", "learner", "published"), courseId: "pact-analytics" },
      { ...publishedContent("analytics-content-global", null, "learner", "published"), courseId: "pact-analytics" }
    ]);
    await db.collection("test_pactContentProgress").insertMany([
      {
        id: "analytics-progress-a",
        courseId: "pact-analytics",
        cohortId: "cohort-analytics-a",
        squadId: "analytics-squad-1",
        userId: "analytics-learner-a",
        contentId: "analytics-content-a",
        contentType: "module",
        answers: { q1: "a" },
        answeredQuestionIds: ["q1"],
        progressPercent: 50,
        score: 5,
        maxScore: 10,
        status: "in_progress",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "analytics-progress-b",
        courseId: "pact-analytics",
        cohortId: "cohort-analytics-b",
        userId: "analytics-learner-b",
        contentId: "analytics-content-global",
        contentType: "module",
        answers: { q1: "a" },
        answeredQuestionIds: ["q1"],
        progressPercent: 100,
        score: 10,
        maxScore: 10,
        status: "submitted",
        submittedAt: now,
        createdAt: now,
        updatedAt: now
      }
    ]);

    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "analytics-instructor",
      role: "instructor",
      courseId: "pact-analytics",
      cohortId: "cohort-analytics-a"
    });
    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "analytics-learner-a",
      role: "learner",
      courseId: "pact-analytics",
      cohortId: "cohort-analytics-a"
    });

    await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/analytics/cohort-progress")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(403);

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/analytics/cohort-progress?cohortId=cohort-analytics-a")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);

    expect(response.body).toMatchObject({
      courseId: "pact-analytics",
      cohortId: "cohort-analytics-a",
      learnerCount: 1,
      assignedContentCount: 2,
      startedContentCount: 1,
      submittedContentCount: 0,
      averageProgressPercent: 50,
      learners: [
        expect.objectContaining({
          userId: "analytics-learner-a",
          name: "Analytics Learner A",
          squadNumber: "1",
          startedCount: 1,
          submittedCount: 0,
          assignedCount: 2,
          averageProgressPercent: 50,
          totalScore: 5,
          maxScore: 10
        })
      ]
    });
    expect(JSON.stringify(response.body)).not.toContain("lms-analytics-learner-a");

    const crossCohortResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/analytics/cohort-progress?cohortId=cohort-analytics-b")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);

    expect(crossCohortResponse.body).toMatchObject({
      cohortId: "cohort-analytics-b",
      learnerCount: 1,
      submittedContentCount: 1,
      averageProgressPercent: 100
    });
  });

  it("lets admins and instructors gate content availability", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactContent").updateOne(
      { id: "content-gated" },
      { $set: publishedContent("content-gated", "cohort-a", "learner", "draft") },
      { upsert: true }
    );

    const learnerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "user-1",
      role: "learner",
      courseId: "pact",
      cohortId: "cohort-a",
      squadId: "squad-1"
    });
    const instructorToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "instructor-1",
      role: "instructor",
      courseId: "pact",
      cohortId: "cohort-a"
    });

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/scores")
      .set("authorization", `Bearer ${learnerToken}`)
      .send({ contentId: "content-gated", score: 8, maxScore: 10, progressPercent: 100 })
      .expect(403);

    const adminList = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/content")
      .set("authorization", `Bearer ${instructorToken}`)
      .expect(200);

    expect(adminList.body.some((item: { id: string; status: string }) => item.id === "content-gated" && item.status === "draft")).toBe(true);

    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/admin/content/content-gated/status")
      .set("authorization", `Bearer ${instructorToken}`)
      .send({ status: "published" })
      .expect(200);

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/scores")
      .set("authorization", `Bearer ${learnerToken}`)
      .send({ contentId: "content-gated", score: 8, maxScore: 10, progressPercent: 100 })
      .expect(201);
  });

  it("returns a signed Deep Linking response form for LMS launches", async () => {
    const idToken = await signDeepLinkLaunch();

    const response = await request(createApp(config, createLogger(config)))
      .post("/api/v1/lti/deep-link")
      .type("form")
      .send({ id_token: idToken })
      .expect(200);

    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain("JWT");
    expect(response.text).toContain("http://lms.example.test/api/v1/lti/deep-linking/return");
  });

  it("accepts Deep Linked module launches and redirects to the frontend with a PACT session", async () => {
    const idToken = await signResourceLaunch();

    const response = await request(createApp(config, createLogger(config)))
      .post("/launch/module")
      .set("accept", "text/html")
      .type("form")
      .send({ id_token: idToken })
      .expect(303);

    expect(response.headers.location).toBe("http://pact.example.test/");
    const sessionToken = sessionTokenFromSetCookie(response.headers["set-cookie"]);
    await expect(new SessionService(config.pactSessionSecret).verify(sessionToken)).resolves.toMatchObject({
      contentType: "module"
    });

    const db = await getMongoDb(config);
    const user = await db.collection("test_pactUsers").findOne({ lmsUserId: "lms-user-launch" });
    expect(user).toMatchObject({
      courseId: "pact",
      cohortId: "cohort-launch",
      role: "learner"
    });
  });

  it("accepts generic LMS course launches without content-type scoping", async () => {
    const idToken = await signResourceLaunch({ targetLinkUri: "http://localhost:4100/launch" });

    const response = await request(createApp(config, createLogger(config)))
      .post("/api/v1/lti/launch")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: idToken })
      .expect(200);

    expect(response.body.user).toMatchObject({
      lmsUserId: "lms-user-launch",
      courseId: "pact",
      cohortId: "cohort-launch"
    });

    const sessionToken = sessionTokenFromSetCookie(response.headers["set-cookie"]);
    const session = await new SessionService(config.pactSessionSecret).verify(sessionToken);
    expect(session).toMatchObject({
      courseId: "pact",
      cohortId: "cohort-launch"
    });
    expect(session.contentType).toBeUndefined();
  });

  it("keeps unlocked dashboard content visible during direct deep-linked assessment launches", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactContent").updateOne(
      { id: "assessment-pretest" },
      { $set: publishedContent("assessment-pretest", "cohort-launch", "learner", "published", "assessment") },
      { upsert: true }
    );
    await db.collection("test_pactContent").updateOne(
      { id: "assessment-posttest" },
      { $set: publishedContent("assessment-posttest", "cohort-launch", "learner", "published", "assessment") },
      { upsert: true }
    );
    await db.collection("test_pactContent").updateOne(
      { id: "workshop:day1-pm-squad-3-visible" },
      { $set: publishedContent("workshop:day1-pm-squad-3-visible", "cohort-launch", "learner", "published", "workshop") },
      { upsert: true }
    );
    const idToken = await signResourceLaunch({
      targetLinkUri: "http://localhost:4100/launch/assessment?contentId=assessment-pretest",
      custom: { content_id: "assessment-pretest" }
    });

    const launchResponse = await request(createApp(config, createLogger(config)))
      .post("/api/v1/lti/launch")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: idToken })
      .expect(200);

    const sessionToken = sessionTokenFromSetCookie(launchResponse.headers["set-cookie"]);
    const session = await new SessionService(config.pactSessionSecret).verify(sessionToken);
    expect(session).toMatchObject({
      contentType: "assessment",
      contentId: "assessment-pretest"
    });

    const contentResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content")
      .set("authorization", `Bearer ${sessionToken}`)
      .expect(200);
    expect(contentResponse.body.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([
      "assessment-pretest",
      "assessment-posttest",
      "workshop:day1-pm-squad-3-visible"
    ]));
  });

  it("rejects resource launches that are missing required LTI claims before creating a session", async () => {
    const missingVersion = await signResourceLaunch({ omitVersion: true });
    const missingContext = await signResourceLaunch({ omitContext: true });
    const missingResourceLink = await signResourceLaunch({ omitResourceLink: true });

    await request(createApp(config, createLogger(config)))
      .post("/launch/module")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: missingVersion })
      .expect(400)
      .expect((response) => {
        expect(response.body.error).toMatchObject({ code: "INVALID_LTI_VERSION" });
        expect(response.headers["set-cookie"]).toBeUndefined();
      });

    await request(createApp(config, createLogger(config)))
      .post("/launch/module")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: missingContext })
      .expect(400)
      .expect((response) => {
        expect(response.body.error).toMatchObject({ code: "CONTEXT_REQUIRED" });
        expect(response.headers["set-cookie"]).toBeUndefined();
      });

    await request(createApp(config, createLogger(config)))
      .post("/launch/module")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: missingResourceLink })
      .expect(400)
      .expect((response) => {
        expect(response.body.error).toMatchObject({ code: "RESOURCE_LINK_REQUIRED" });
        expect(response.headers["set-cookie"]).toBeUndefined();
      });
  });

  it("rejects resource launches with untrusted target link URIs", async () => {
    const foreignOrigin = await signResourceLaunch({ targetLinkUri: "https://attacker.example.test/launch/module" });
    const unsupportedPath = await signResourceLaunch({ targetLinkUri: "http://localhost:4100/admin/session" });

    await request(createApp(config, createLogger(config)))
      .post("/launch/module")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: foreignOrigin })
      .expect(400)
      .expect((response) => {
        expect(response.body.error).toMatchObject({ code: "TARGET_LINK_REQUIRED" });
        expect(response.headers["set-cookie"]).toBeUndefined();
      });

    await request(createApp(config, createLogger(config)))
      .post("/launch/module")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: unsupportedPath })
      .expect(400)
      .expect((response) => {
        expect(response.body.error).toMatchObject({ code: "TARGET_LINK_REQUIRED" });
        expect(response.headers["set-cookie"]).toBeUndefined();
      });
  });

  it("keeps squad assignment PACT-owned during LMS launches", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactSquads").insertOne({
      id: "pact-owned-squad-3",
      courseId: "pact",
      cohortId: "cohort-launch",
      name: "Squad 3",
      number: "3",
      createdAt: now,
      updatedAt: now
    });
    await db.collection("test_pactUsers").updateOne(
      { lmsUserId: "lms-user-launch" },
      {
        $set: {
          id: "pact-owned-launch-user",
          lmsUserId: "lms-user-launch",
          role: "learner",
          courseId: "pact",
          cohortId: "cohort-launch",
          squadId: "pact-owned-squad-3",
          createdAt: now,
          updatedAt: now
        }
      },
      { upsert: true }
    );

    const idToken = await signResourceLaunch({ custom: { squad_id: "lms-squad-should-not-win" } });
    const launchResponse = await request(createApp(config, createLogger(config)))
      .post("/launch/module")
      .set("accept", "text/html")
      .type("form")
      .send({ id_token: idToken })
      .expect(303);
    const sessionCookie = sessionCookieFromSetCookie(launchResponse.headers["set-cookie"]);

    const sessionResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/session")
      .set("cookie", sessionCookie)
      .expect(200);
    const csrfToken = sessionResponse.body.csrfToken;
    expect(csrfToken).toEqual(expect.any(String));
    const user = await db.collection("test_pactUsers").findOne({ lmsUserId: "lms-user-launch" });

    expect(user).toMatchObject({ squadId: "pact-owned-squad-3" });
    expect(sessionResponse.body).toMatchObject({
      userId: "pact-owned-launch-user",
      squadId: "pact-owned-squad-3",
      squadNumber: "3"
    });

    await db.collection("test_pactContent").updateOne(
      { id: "cookie-protected-content" },
      { $set: publishedContent("cookie-protected-content", "cohort-launch", "learner", "published", "module") },
      { upsert: true }
    );
    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/content/cookie-protected-content/progress")
      .set("cookie", sessionCookie)
      .send({ progressPercent: 25 })
      .expect(403);
    await request(createApp(config, createLogger(config)))
      .patch("/api/v1/content/cookie-protected-content/progress")
      .set("cookie", sessionCookie)
      .set("x-csrf-token", csrfToken)
      .send({ progressPercent: 25 })
      .expect(200);
  });

  it("clears the PACT session cookie on logout", async () => {
    const idToken = await signResourceLaunch({ custom: { squad_id: "lms-squad-should-not-win" } });
    const launchResponse = await request(createApp(config, createLogger(config)))
      .post("/launch/module")
      .set("accept", "text/html")
      .type("form")
      .send({ id_token: idToken })
      .expect(303);
    const sessionCookie = sessionCookieFromSetCookie(launchResponse.headers["set-cookie"]);
    const sessionResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/session")
      .set("cookie", sessionCookie)
      .expect(200);

    await request(createApp(config, createLogger(config)))
      .delete("/api/v1/session")
      .set("cookie", sessionCookie)
      .send()
      .expect(403);

    const logoutResponse = await request(createApp(config, createLogger(config)))
      .delete("/api/v1/session")
      .set("cookie", sessionCookie)
      .set("x-csrf-token", sessionResponse.body.csrfToken)
      .send()
      .expect(204);

    const setCookie = logoutResponse.headers["set-cookie"];
    const clearedCookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .find((item: string | undefined) => item?.startsWith(`${pactSessionCookieName}=`));
    expect(clearedCookie).toContain("Max-Age=0");
    expect(clearedCookie).toContain("HttpOnly");
  });

  it("prefers explicit bearer sessions over stale PACT cookies", async () => {
    const db = await getMongoDb(config);
    const now = new Date().toISOString();
    await db.collection("test_pactUsers").insertMany([
      {
        id: "stale-cookie-admin",
        lmsUserId: "lms-stale-cookie-admin",
        role: "admin",
        courseId: "pact-stale-cookie",
        cohortId: "cohort-stale-cookie",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "bearer-learner",
        lmsUserId: "lms-bearer-learner",
        role: "learner",
        courseId: "pact-stale-cookie",
        cohortId: "cohort-stale-cookie",
        createdAt: now,
        updatedAt: now
      }
    ]);

    const adminCookieToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "stale-cookie-admin",
      role: "admin",
      courseId: "pact-stale-cookie",
      cohortId: "cohort-stale-cookie"
    });
    const learnerBearerToken = await new SessionService(config.pactSessionSecret).sign({
      userId: "bearer-learner",
      role: "learner",
      courseId: "pact-stale-cookie",
      cohortId: "cohort-stale-cookie"
    });

    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/session")
      .set("cookie", `${pactSessionCookieName}=${encodeURIComponent(adminCookieToken)}`)
      .set("authorization", `Bearer ${learnerBearerToken}`)
      .expect(200);

    expect(response.body).toMatchObject({
      userId: "bearer-learner",
      role: "learner"
    });
  });

  it("returns a signed Deep Linking JSON payload for frontend relays", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactContent").updateOne(
      { id: "lms-label-challenge" },
      {
        $set: {
          ...publishedContent("lms-label-challenge", null, "learner", "published", "challenge"),
          lmsLabel: "PACT Team Challenge Launch"
        }
      },
      { upsert: true }
    );
    await db.collection("test_pactContent").updateOne(
      { id: "assessment-pretest" },
      {
        $set: {
          ...publishedContent("assessment-pretest", null, "learner", "published", "assessment"),
          lmsLabel: "PACT Pre-test"
        }
      },
      { upsert: true }
    );
    const idToken = await signDeepLinkLaunch();

    const response = await request(createApp(config, createLogger(config)))
      .post("/api/v1/lti/deep-link")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: idToken })
      .expect(200);

    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).toMatchObject({
      returnUrl: "http://lms.example.test/api/v1/lti/deep-linking/return"
    });
    expect(response.body.jwt).toEqual(expect.any(String));
    const deepLinkPayload = JSON.parse(Buffer.from(response.body.jwt.split(".")[1], "base64url").toString("utf8"));
    expect(deepLinkPayload["https://purl.imsglobal.org/spec/lti-dl/claim/content_items"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "http://localhost:4100/launch/assessment",
          lineItem: expect.objectContaining({ resourceId: "pact-assessment-hub", tag: "assessment" })
        }),
        expect.objectContaining({
          title: "PACT Team Challenge Launch",
          url: "http://localhost:4100/launch/challenge",
          lineItem: expect.objectContaining({ label: "PACT Team Challenge Launch", resourceId: "pact-challenge-hub", tag: "challenge" })
        }),
        expect.objectContaining({
          title: "PACT Workshops",
          url: "http://localhost:4100/launch/workshop",
          lineItem: expect.objectContaining({ label: "PACT Workshops", resourceId: "pact-workshop-hub", tag: "workshop" })
        }),
        expect.objectContaining({
          title: "PACT Pre-test",
          url: "http://localhost:4100/launch/assessment?contentId=assessment-pretest",
          custom: { content_id: "assessment-pretest" },
          lineItem: expect.objectContaining({ label: "PACT Pre-test", resourceId: "assessment-pretest", tag: "assessment" })
        })
      ])
    );
    expect(JSON.stringify(deepLinkPayload["https://purl.imsglobal.org/spec/lti-dl/claim/content_items"])).not.toContain("Squad");
  });

  it("rejects Deep Linking launches with untrusted target link URIs", async () => {
    const idToken = await signDeepLinkLaunch({ targetLinkUri: "https://attacker.example.test/api/v1/lti/deep-link" });

    await request(createApp(config, createLogger(config)))
      .post("/api/v1/lti/deep-link")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: idToken })
      .expect(400)
      .expect((response) => {
        expect(response.body.error).toMatchObject({ code: "TARGET_LINK_REQUIRED" });
      });
  });

  it("rejects legacy LTI target link paths when compatibility is disabled", async () => {
    const strictConfig = { ...config, pactAllowLegacyLtiPaths: false };
    const idToken = await signDeepLinkLaunch({ targetLinkUri: "http://localhost:4100/lti/deep-link" });

    await request(createApp(strictConfig, createLogger(strictConfig)))
      .post("/api/v1/lti/deep-link")
      .set("accept", "application/json")
      .type("form")
      .send({ id_token: idToken })
      .expect(400)
      .expect((response) => {
        expect(response.body.error).toMatchObject({ code: "TARGET_LINK_REQUIRED" });
      });
  });

  it("creates authenticated bug reports and syncs them to Linear", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          teams: { nodes: [{ id: "linear-team-id", key: "PACT", name: "PACT" }] },
          projects: { nodes: [{ id: "linear-project-id", name: "PACT Bugs" }] }
        }
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "linear-issue-id",
              identifier: "PACT-42",
              title: "[PACT Bug] Activity will not submit",
              url: "https://linear.app/cetu/issue/PACT-42/activity-will-not-submit",
              state: { name: "Triage", type: "unstarted" }
            }
          }
        }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const linearConfig: AppConfig = {
      ...config,
      linearBugSyncEnabled: true,
      linearApiKey: "lin_api_test",
      linearTeamKey: "PACT",
      linearProjectName: "PACT Bugs"
    };
    const token = await new SessionService(config.pactSessionSecret).sign({
      userId: "bug-reporter",
      role: "learner",
      courseId: "pact-bugs",
      cohortId: "cohort-bugs",
      squadId: "squad-1"
    });

    try {
      const response = await request(createApp(linearConfig, createLogger(linearConfig)))
        .post("/api/v1/bug-reports")
        .set("authorization", `Bearer ${token}`)
        .send({
          title: "Activity will not submit",
          description: "The submit button stays disabled after I answer every question.",
          severity: "high",
          pageUrl: "https://pact.example.test/training",
          userAgent: "vitest"
        })
        .expect(201);

      expect(response.body).toMatchObject({
        title: "Activity will not submit",
        reporterUserId: "bug-reporter",
        linearIssueId: "linear-issue-id",
        linearIssueIdentifier: "PACT-42",
        linearIssueState: "Triage",
        syncStatus: "synced"
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const mutationBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
      expect(mutationBody.variables.input).toMatchObject({
        teamId: "linear-team-id",
        projectId: "linear-project-id",
        priority: 2
      });
      expect(mutationBody.variables.input.description).toContain("PACT bug report ID:");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("syncs Linear webhook issue state updates for bug reports", async () => {
    const db = await getMongoDb(config);
    await db.collection("test_pactBugReports").insertOne({
      id: "bug-report-webhook",
      title: "Webhook report",
      description: "A report created before the webhook update.",
      severity: "medium",
      courseId: "pact-bugs",
      cohortId: "cohort-bugs",
      reporterUserId: "bug-reporter",
      reporterRole: "learner",
      linearIssueId: "linear-issue-webhook",
      linearIssueIdentifier: "PACT-99",
      syncStatus: "synced",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const webhookConfig = { ...config, linearWebhookSecret: "test-linear-webhook-secret" };
    const body = JSON.stringify({
      type: "Issue",
      action: "update",
      webhookTimestamp: Date.now(),
      data: {
        id: "linear-issue-webhook",
        identifier: "PACT-99",
        url: "https://linear.app/cetu/issue/PACT-99/webhook-report",
        state: { name: "Done", type: "completed" }
      }
    });
    const signature = createHmac("sha256", webhookConfig.linearWebhookSecret).update(body).digest("hex");

    await request(createApp(webhookConfig, createLogger(webhookConfig)))
      .post("/api/v1/webhooks/linear")
      .set("linear-signature", signature)
      .set("content-type", "application/json")
      .send(body)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ matched: 1, modified: 1 });
      });

    const report = await db.collection("test_pactBugReports").findOne({ id: "bug-report-webhook" });
    expect(report).toMatchObject({
      linearIssueIdentifier: "PACT-99",
      linearIssueState: "Done",
      linearIssueUrl: "https://linear.app/cetu/issue/PACT-99/webhook-report"
    });
  });

  it("maps unavailable LMS JWKS to an explicit LTI platform error", async () => {
    const failingJwksServer = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "jwks unavailable" }));
    });
    await new Promise<void>((resolve) => failingJwksServer.listen(0, "127.0.0.1", resolve));
    const address = failingJwksServer.address();
    if (typeof address !== "object" || !address) throw new Error("Failing JWKS server did not start");

    const badConfig = {
      ...config,
      lmsPlatformJwksUri: `http://127.0.0.1:${address.port}/jwks`
    };
    const idToken = await signDeepLinkLaunch();

    try {
      const response = await request(createApp(badConfig, createLogger(badConfig)))
        .post("/api/v1/lti/deep-link")
        .type("form")
        .send({ id_token: idToken })
        .expect(502);

      expect(response.body.error).toMatchObject({
        code: "LTI_PLATFORM_JWKS_UNAVAILABLE",
        message: "LMS LTI signing keys are temporarily unavailable"
      });
    } finally {
      await new Promise<void>((resolve, reject) => failingJwksServer.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("publishes the PACT tool JWKS for LMS registration", async () => {
    const response = await request(createApp(config, createLogger(config)))
      .get("/api/v1/lti/jwks")
      .expect(200);

    expect(response.body.keys[0]).toMatchObject({ kid: "pact-key", alg: "RS256", use: "sig" });
  });
});

async function signDeepLinkLaunch(options: { targetLinkUri?: string } = {}) {
  return new SignJWT({
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingRequest",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": "deployment-1",
    "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": options.targetLinkUri ?? "http://localhost:4100/api/v1/lti/deep-link",
    "https://purl.imsglobal.org/spec/lti/claim/context": { id: "cohort-a", title: "PACT" },
    "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings": {
      deep_link_return_url: "http://lms.example.test/api/v1/lti/deep-linking/return",
      accept_types: ["ltiResourceLink"],
      accept_multiple: true
    }
  })
    .setProtectedHeader({ alg: "RS256", kid: "platform-key" })
    .setIssuer(config.lmsPlatformIssuer)
    .setAudience(config.pactLtiClientId)
    .setSubject("admin-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(platformPrivateKey);
}

async function signResourceLaunch(options: {
  ags?: { lineitems?: string; lineitem?: string; scope?: string[] };
  custom?: Record<string, string>;
  omitContext?: boolean;
  omitResourceLink?: boolean;
  omitVersion?: boolean;
  targetLinkUri?: string;
} = {}) {
  return new SignJWT({
    name: "Launch Learner",
    email: "launch.learner@example.test",
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiResourceLinkRequest",
    ...(options.omitVersion ? {} : { "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0" }),
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": "deployment-1",
    "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": options.targetLinkUri ?? "http://localhost:4100/launch/module",
    ...(options.omitContext ? {} : { "https://purl.imsglobal.org/spec/lti/claim/context": { id: "cohort-launch", title: "PACT" } }),
    "https://purl.imsglobal.org/spec/lti/claim/custom": options.custom,
    "https://purl.imsglobal.org/spec/lti/claim/roles": ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    ...(options.ags ? { "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint": options.ags } : {}),
    ...(options.omitResourceLink ? {} : { "https://purl.imsglobal.org/spec/lti/claim/resource_link": { id: "pact-module-hub", title: "PACT Modules" } })
  })
    .setProtectedHeader({ alg: "RS256", kid: "platform-key" })
    .setIssuer(config.lmsPlatformIssuer)
    .setAudience(config.pactLtiClientId)
    .setSubject("lms-user-launch")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(platformPrivateKey);
}

async function signAdminLaunchWithAgs() {
  return new SignJWT({
    name: "Launch Admin",
    email: "launch.admin@example.test",
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiResourceLinkRequest",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": "deployment-1",
    "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": "http://localhost:4100/launch",
    "https://purl.imsglobal.org/spec/lti/claim/context": { id: "cohort-launch", title: "PACT" },
    "https://purl.imsglobal.org/spec/lti/claim/roles": ["http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator"],
    "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint": {
      lineitems: "http://lms.example.test/api/v1/lti/ags/lineitems",
      scope: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"]
    },
    "https://purl.imsglobal.org/spec/lti/claim/resource_link": { id: "pact-admin-hub", title: "PACT Admin" }
  })
    .setProtectedHeader({ alg: "RS256", kid: "platform-key" })
    .setIssuer(config.lmsPlatformIssuer)
    .setAudience(config.pactLtiClientId)
    .setSubject("lms-admin-launch")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(platformPrivateKey);
}

function publishedContent(id: string, cohortId: string | null, role: "learner" | "admin", status = "published", type = "module", locked = false) {
  const now = new Date().toISOString();
  return {
    id,
    courseId: "pact",
    cohortId,
    role,
    type,
    title: id,
    prompt: "Answer the prompt",
    maxScore: 10,
    status,
    locked,
    createdAt: now,
    updatedAt: now
  };
}

function policyQuestion(
  id: string,
  payload: Record<string, unknown>,
  scoring: {
    points: number;
    optional?: boolean;
    maxAttempts?: number;
    mustPass?: boolean;
    gradingMode?: "automatic" | "manual";
  }
) {
  const now = new Date().toISOString();
  return {
    id,
    version: 1,
    supersedes: null,
    type: String(payload.kind ?? "question"),
    day: "1",
    role: "learner",
    topic: id,
    tags: [],
    stem: { en: id },
    payload,
    feedback: {
      correct: { en: "Correct." },
      incorrect: { en: "Incorrect." },
      needs_review: { en: "Submitted for review." }
    },
    scoring: {
      difficulty: "easy",
      mustPass: scoring.mustPass ?? false,
      ...scoring
    },
    status: "published",
    createdAt: now,
    updatedAt: now
  };
}

function sessionTokenFromSetCookie(setCookie: string | string[] | undefined) {
  const cookie = sessionCookieFromSetCookie(setCookie);
  const value = cookie.split("=", 2)[1];
  expect(value).toEqual(expect.any(String));
  return decodeURIComponent(value);
}

function sessionCookieFromSetCookie(setCookie: string | string[] | undefined) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  expect(values.length).toBeGreaterThan(0);
  const cookie = values.find((item) => item.startsWith(`${pactSessionCookieName}=`));
  expect(cookie).toEqual(expect.any(String));
  expect(cookie).toContain("HttpOnly");
  return cookie?.split(";", 1)[0] ?? "";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
