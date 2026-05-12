import "dotenv/config";
import { loadConfig } from "../config/config.js";
import { ensureMongoCollections } from "./mongo.js";

await ensureMongoCollections(loadConfig(process.env));
console.log("PACT Mongo collections are ready");
