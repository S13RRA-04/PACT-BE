import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config/config.js";
import { ensureMongoCollections } from "./db/mongo.js";
import { createLogger } from "./logging/logger.js";

const config = loadConfig(process.env);
const logger = createLogger(config);

await ensureMongoCollections(config);

createApp(config, logger).listen(config.port, () => {
  logger.info({ port: config.port, mongoDbName: config.mongoDbName, prefix: config.mongoCollectionPrefix }, "PACT API listening");
});
