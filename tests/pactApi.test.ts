import http from "node:http";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config/config.js";
import { ensureMongoCollections, getMongoDb } from "../src/db/mongo.js";
import { SessionService } from "../src/auth/sessionService.js";
import { createLogger } from "../src/logging/logger.js";

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
    corsOrigins: []
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

    await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/audit-events")
      .set("authorization", `Bearer ${learnerToken}`)
      .expect(403);

    const auditResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/admin/audit-events")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(auditResponse.body.events[0]).toMatchObject({
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

    const listResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/content/progress")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    expect(listResponse.body.progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ contentId: "progress-content", progressPercent: 50 })
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

    expect(response.headers.location).toMatch(/^http:\/\/pact\.example\.test\/#sessionToken=/);
    const launchUrl = new URL(response.headers.location);
    const sessionToken = new URLSearchParams(launchUrl.hash.replace(/^#/, "")).get("sessionToken");
    expect(sessionToken).toEqual(expect.any(String));
    await expect(new SessionService(config.pactSessionSecret).verify(sessionToken as string)).resolves.toMatchObject({
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
    const launchUrl = new URL(launchResponse.headers.location);
    const sessionToken = new URLSearchParams(launchUrl.hash.replace(/^#/, "")).get("sessionToken");

    const sessionResponse = await request(createApp(config, createLogger(config)))
      .get("/api/v1/session")
      .set("authorization", `Bearer ${sessionToken}`)
      .expect(200);
    const user = await db.collection("test_pactUsers").findOne({ lmsUserId: "lms-user-launch" });

    expect(user).toMatchObject({ squadId: "pact-owned-squad-3" });
    expect(sessionResponse.body).toMatchObject({
      userId: "pact-owned-launch-user",
      squadId: "pact-owned-squad-3",
      squadNumber: "3"
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

async function signDeepLinkLaunch() {
  return new SignJWT({
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingRequest",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": "deployment-1",
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

async function signResourceLaunch(options: { custom?: Record<string, string> } = {}) {
  return new SignJWT({
    name: "Launch Learner",
    email: "launch.learner@example.test",
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiResourceLinkRequest",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": "deployment-1",
    "https://purl.imsglobal.org/spec/lti/claim/context": { id: "cohort-launch", title: "PACT" },
    "https://purl.imsglobal.org/spec/lti/claim/custom": options.custom,
    "https://purl.imsglobal.org/spec/lti/claim/roles": ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    "https://purl.imsglobal.org/spec/lti/claim/resource_link": { id: "pact-module-hub", title: "PACT Modules" }
  })
    .setProtectedHeader({ alg: "RS256", kid: "platform-key" })
    .setIssuer(config.lmsPlatformIssuer)
    .setAudience(config.pactLtiClientId)
    .setSubject("lms-user-launch")
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
