import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config/config.js";
import { ensureMongoCollections, getMongoDb } from "./db/mongo.js";
import { createLogger } from "./logging/logger.js";
import { PactRepository } from "./repositories/pactRepository.js";
import { AgsMaintenanceService } from "./services/agsMaintenanceService.js";
import { PactService } from "./services/pactService.js";
import { LmsAgsClient } from "./integrations/lmsAgsClient.js";
import { LmsTokenClient } from "./integrations/lmsTokenClient.js";

const config = loadConfig(process.env);
const logger = createLogger(config);

await ensureMongoCollections(config);
const repository = new PactRepository(await getMongoDb(config), config);
new AgsMaintenanceService(
  config,
  repository,
  new PactService(repository, new LmsAgsClient(), new LmsTokenClient(config), config),
  logger
).start();

createApp(config, logger).listen(config.port, () => {
  logger.info({ port: config.port, mongoDbName: config.mongoDbName, prefix: config.mongoCollectionPrefix }, "PACT API listening");
});
