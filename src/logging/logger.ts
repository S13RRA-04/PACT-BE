import pino from "pino";
import type { AppConfig } from "../config/config.js";

export type AppLogger = ReturnType<typeof createLogger>;

export function createLogger(config: AppConfig) {
  return pino({
    level: config.env === "production" ? "info" : "debug",
    redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-csrf-token", "authorization", "token", "accessToken", "idToken"]
  });
}
