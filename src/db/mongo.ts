import { Db, MongoClient } from "mongodb";
import type { AppConfig } from "../config/config.js";

let client: MongoClient | undefined;

export async function getMongoDb(config: AppConfig): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongoUri);
    await client.connect();
  }
  return client.db(config.mongoDbName);
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
}
