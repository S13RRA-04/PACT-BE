import http from "node:http";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT, type KeyLike } from "jose";
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
    agsRetryExhaustedWebhookMaxDelayMs: 3600000
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

  it("scopes learner content to the launched content type", async () => {
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
    expect(contentIds).not.toContain("module-scoped-challenge");
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
      scopes: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
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
      scopes: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
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

  it("scores question submissions immediately and waits for content completion before publishing AGS", async () => {
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
      { id: "completion-gated-attempt-content" },
      {
        $set: {
          ...publishedContent("completion-gated-attempt-content", "cohort-launch", "learner", "published", "module"),
          lineItemUrl: "http://lms.example.test/api/v1/lti/ags/lineitems/completion-gated",
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
        agsStatus: "pending"
      });
      expect(secondAttempt.body.progress).toMatchObject({
        status: "submitted",
        score: 10,
        maxScore: 10,
        progressPercent: 100
      });
      expect(fetchMock).not.toHaveBeenCalled();
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
      expect(completionStatus.body.score).toMatchObject({ agsStatus: "pending" });

      const queuedAttempts = await db.collection("test_pactAgsPublishAttempts")
        .find({ contentId: "completion-gated-attempt-content", userId: launchResponse.body.user.id })
        .toArray();
      expect(queuedAttempts).toHaveLength(1);
      expect(queuedAttempts[0]).toMatchObject({
        status: "pending",
        score: 10,
        maxScore: 10,
        retryCount: 0
      });

      const retryResult = await new PactService(
        new PactRepository(db, config),
        new LmsAgsClient(),
        new LmsTokenClient(config),
        config
      ).retryDueAgsPublishAttempts(25, { courseId: "pact" });

      expect(retryResult).toMatchObject({ scanned: 1, retried: 1, failed: 0, exhausted: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://lms.example.test/api/v1/lti/ags/lineitems/completion-gated/scores",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer completion-ags-token" })
        })
      );
      const attempts = await db.collection("test_pactAgsPublishAttempts")
        .find({ contentId: "completion-gated-attempt-content", userId: launchResponse.body.user.id })
        .toArray();
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ status: "published", retryCount: 1 });
      expect(JSON.stringify(attempts)).not.toContain("completion-ags-token");
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
          title: "PACT Assessments",
          url: "http://localhost:4100/launch/assessment",
          lineItem: expect.objectContaining({ resourceId: "pact-assessment-hub", tag: "assessment" })
        }),
        expect.objectContaining({
          title: "PACT Team Challenge Launch",
          url: "http://localhost:4100/launch/challenge",
          lineItem: expect.objectContaining({ label: "PACT Team Challenge Launch", resourceId: "pact-challenge-hub", tag: "challenge" })
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

function publishedContent(id: string, cohortId: string | null, role: "learner" | "admin", status = "published", type = "module") {
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
