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
      publishedContent("admin-visible-other-cohort", "cohort-b", "learner", "draft")
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
      "admin-visible-assessment"
    ]));
    expect(instructorResponse.body.some((item: { id: string }) => item.id === "admin-visible-other-cohort")).toBe(false);
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

    const db = await getMongoDb(config);
    const user = await db.collection("test_pactUsers").findOne({ lmsUserId: "lms-user-launch" });
    expect(user).toMatchObject({
      courseId: "pact",
      cohortId: "cohort-launch",
      role: "learner"
    });
  });

  it("returns a signed Deep Linking JSON payload for frontend relays", async () => {
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
        })
      ])
    );
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

async function signResourceLaunch() {
  return new SignJWT({
    name: "Launch Learner",
    email: "launch.learner@example.test",
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiResourceLinkRequest",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": "deployment-1",
    "https://purl.imsglobal.org/spec/lti/claim/context": { id: "cohort-launch", label: "pact", title: "PACT" },
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

function publishedContent(id: string, cohortId: string, role: "learner" | "admin", status = "published", type = "module") {
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
