import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config/config.js";
import { AppError } from "../errors/AppError.js";
import { SessionService, type PactSession } from "../auth/sessionService.js";

export function currentSession(config: AppConfig) {
  const sessions = new SessionService(config.pactSessionSecret);
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.header("authorization");
      if (!header?.startsWith("Bearer ")) {
        throw new AppError(401, "AUTH_REQUIRED", "Authentication is required");
      }
      req.pactSession = await sessions.verify(header.slice("Bearer ".length));
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requirePactRole(...roles: PactSession["role"][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.pactSession) {
      next(new AppError(401, "AUTH_REQUIRED", "Authentication is required"));
      return;
    }
    if (!roles.includes(req.pactSession.role)) {
      next(new AppError(403, "FORBIDDEN", "User does not have permission to access this resource"));
      return;
    }
    next();
  };
}

declare global {
  namespace Express {
    interface Request {
      pactSession?: PactSession;
    }
  }
}
