import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { isAppError } from "../errors/AppError.js";
import type { AppLogger } from "../logging/logger.js";

export function errorHandler(logger: AppLogger) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: { code: "VALIDATION_FAILED", message: "Request validation failed", details: error.flatten(), requestId: req.requestId } });
      return;
    }

    if (isAppError(error)) {
      res.status(error.statusCode).json({ error: { code: error.code, message: error.message, requestId: req.requestId } });
      return;
    }

    logger.error({ error, requestId: req.requestId }, "Unhandled request failure");
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error", requestId: req.requestId } });
  };
}
