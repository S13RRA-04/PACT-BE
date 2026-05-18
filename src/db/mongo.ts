import { Db, MongoClient } from "mongodb";
import type { AppConfig } from "../config/config.js";

const clients = new Map<string, Promise<MongoClient>>();

export async function getMongoDb(config: AppConfig): Promise<Db> {
  return getMongoDatabase(config, config.mongoDbName);
}

export async function getMongoDatabase(config: AppConfig, databaseName: string): Promise<Db> {
  const key = mongoClientKey(config);
  let clientPromise = clients.get(key);

  if (!clientPromise) {
    clientPromise = connectMongoClient(config);
    clients.set(key, clientPromise);
  }

  const client = await clientPromise;
  return client.db(databaseName);
}

export async function closeMongoClient() {
  const clientPromises = [...clients.values()];
  clients.clear();
  await Promise.all(clientPromises.map(async (clientPromise) => (await clientPromise).close()));
}

async function connectMongoClient(config: AppConfig) {
  const client = new MongoClient(config.mongoUri);
  await client.connect();
  return client;
}

function mongoClientKey(config: AppConfig) {
  return config.mongoUri;
}

export function collectionName(config: AppConfig, name: string) {
  return `${config.mongoCollectionPrefix}${name}`;
}

export async function ensureMongoCollections(config: AppConfig) {
  const db = await getMongoDb(config);
  await db.collection(collectionName(config, "pactUsers")).createIndex({ lmsUserId: 1 }, { unique: true });
  await db.collection(collectionName(config, "pactUsers")).createIndex({ courseId: 1, cohortId: 1, squadId: 1 });
  await db.collection(collectionName(config, "pactSquads")).createIndex({ courseId: 1, cohortId: 1, name: 1 }, { unique: true });
  await db.collection(collectionName(config, "pactContent")).createIndex({ courseId: 1, cohortId: 1, type: 1, status: 1 });
  await db.collection(collectionName(config, "pactScores")).createIndex({ courseId: 1, userId: 1, contentId: 1 }, { unique: true });
  await db.collection(collectionName(config, "pactScores")).createIndex({ courseId: 1, cohortId: 1, squadId: 1 });
  await db.collection(collectionName(config, "pactContentProgress")).createIndex({ userId: 1, contentId: 1 }, { unique: true });
  await db.collection(collectionName(config, "pactContentProgress")).createIndex({ courseId: 1, cohortId: 1, userId: 1 });
  await db.collection(collectionName(config, "pactContentProgress")).createIndex(
    { scope: 1, courseId: 1, cohortId: 1, squadId: 1, contentId: 1 },
    { unique: true, partialFilterExpression: { scope: "squad" } }
  );
  await db.collection(collectionName(config, "pactQuestionAttempts")).createIndex({ courseId: 1, cohortId: 1, userId: 1, submittedAt: -1 });
  await db.collection(collectionName(config, "pactQuestionAttempts")).createIndex({ userId: 1, contentId: 1, questionId: 1, submittedAt: -1 });
  await db.collection(collectionName(config, "pactQuestionAttempts")).createIndex({ courseId: 1, cohortId: 1, contentId: 1, questionId: 1 });
  await db.collection(collectionName(config, "pactQuestionGrades")).createIndex({ attemptId: 1 }, { unique: true });
  await db.collection(collectionName(config, "pactQuestionGrades")).createIndex({ courseId: 1, cohortId: 1, contentId: 1, questionId: 1 });
  await db.collection(collectionName(config, "pactAuditEvents")).createIndex({ courseId: 1, cohortId: 1, action: 1, createdAt: -1 });
  await db.collection(collectionName(config, "pactAuditEvents")).createIndex({ actorUserId: 1, targetUserId: 1, createdAt: -1 });
  await db.collection(collectionName(config, "pactAgsPublishAttempts")).createIndex({ courseId: 1, cohortId: 1, contentId: 1, userId: 1, createdAt: -1 });
  await db.collection(collectionName(config, "pactAgsPublishAttempts")).createIndex({ status: 1, createdAt: -1 });
  await db.collection(collectionName(config, "pactAgsPublishAttempts")).createIndex({ status: 1, nextRetryAt: 1 });
  await db.collection(collectionName(config, "pactAgsContexts")).createIndex({ userId: 1, courseId: 1, cohortId: 1 }, { unique: true });
  await db.collection(collectionName(config, "pactAgsContexts")).createIndex({ courseId: 1, cohortId: 1, updatedAt: -1 });
  await db.collection(collectionName(config, "pactNotifications")).createIndex({ status: 1, nextAttemptAt: 1 });
  await db.collection(collectionName(config, "pactNotifications")).createIndex({ event: 1, createdAt: -1 });
  await db.collection(collectionName(config, "pactBugReports")).createIndex({ courseId: 1, cohortId: 1, createdAt: -1 });
  await db.collection(collectionName(config, "pactBugReports")).createIndex({ reporterUserId: 1, createdAt: -1 });
  await db.collection(collectionName(config, "pactBugReports")).createIndex({ linearIssueId: 1 }, { sparse: true });
}
