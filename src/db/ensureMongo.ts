import "dotenv/config";
import { loadConfig } from "../config/config.js";
import { closeMongoClient, ensureMongoCollections } from "./mongo.js";

try {
  const config = loadConfig(process.env);
  await ensureMongoCollections(config);
  console.log(`PACT Mongo collections are ready in ${config.mongoDbName} with prefix "${config.mongoCollectionPrefix}"`);
} finally {
  await closeMongoClient();
}
