import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import type { AppConfig } from "./config/config.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestId } from "./middleware/requestId.js";
import { createApiRouter, ltiLaunchHandler } from "./routes/index.js";
import type { AppLogger } from "./logging/logger.js";

export function createApp(config: AppConfig, logger: AppLogger) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(requestId);
  app.use((pinoHttp as unknown as (options: { logger: AppLogger }) => express.RequestHandler)({ logger }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "pact-api" });
  });

  app.post("/launch/:contentType", ltiLaunchHandler(config));
  app.use("/api/v1", createApiRouter(config));
  app.use(errorHandler(logger));
  return app;
}
