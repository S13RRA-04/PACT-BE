import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { migrateScoringFields, type ContentDocument } from "../src/db/migrateScoringFields.js";

let mongo: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

describe("scoring field migration", () => {
  it("reports changes in dry-run mode without modifying content", async () => {
    const collection = client.db("PACT_MIGRATION_TEST").collection<ContentDocument>("dryRunContent");
    await collection.insertOne({
      id: "dry-run-content",
      courseId: "course-a",
      questions: [
        { id: "q1", scoring: { points: 5, difficulty: "easy" } },
        { id: "q2", scoring: { difficulty: "easy" } }
      ]
    });

    const summary = await migrateScoringFields(collection, { apply: false });
    const document = await collection.findOne({ id: "dry-run-content" });

    expect(summary).toMatchObject({
      dryRun: true,
      scannedContent: 1,
      changedContent: 1,
      changedQuestions: 2,
      appliedContent: 0,
      missingPointQuestions: [{ contentId: "dry-run-content", questionId: "q2" }]
    });
    expect(document?.questions?.[0].scoring).toEqual({ points: 5, difficulty: "easy" });
  });

  it("applies default scoring fields while preserving existing values and course filters", async () => {
    const collection = client.db("PACT_MIGRATION_TEST").collection<ContentDocument>("applyContent");
    await collection.insertMany([
      {
        id: "apply-content",
        courseId: "course-a",
        questions: [
          { id: "q1", scoring: { points: 4, difficulty: "easy", optional: true } },
          { id: "q2", scoring: { points: 6, difficulty: "hard", gradingMode: "manual", mustPass: true } }
        ]
      },
      {
        id: "other-course-content",
        courseId: "course-b",
        questions: [{ id: "q3", scoring: { points: 3, difficulty: "easy" } }]
      }
    ]);

    const summary = await migrateScoringFields(collection, { apply: true, courseId: "course-a" });
    const changed = await collection.findOne({ id: "apply-content" });
    const untouched = await collection.findOne({ id: "other-course-content" });

    expect(summary).toMatchObject({
      dryRun: false,
      scannedContent: 1,
      changedContent: 1,
      changedQuestions: 2,
      appliedContent: 1
    });
    expect(changed?.questions?.[0].scoring).toMatchObject({
      points: 4,
      difficulty: "easy",
      optional: true,
      mustPass: false,
      gradingMode: "automatic"
    });
    expect(changed?.questions?.[1].scoring).toMatchObject({
      points: 6,
      difficulty: "hard",
      optional: false,
      mustPass: true,
      gradingMode: "manual"
    });
    expect(changed?.updatedAt).toEqual(expect.any(String));
    expect(untouched?.questions?.[0].scoring).toEqual({ points: 3, difficulty: "easy" });
  });
});
