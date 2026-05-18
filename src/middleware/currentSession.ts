import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config/config.js";
import { AppError } from "../errors/AppError.js";
import { SessionService, type PactSession } from "../auth/sessionService.js";

export const pactSessionCookieName = "pact_session";

export function currentSession(config: AppConfig) {
  const sessions = new SessionService(config.pactSessionSecret);
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const cookieToken = readSessionCookie(req.header("cookie"));
      const bearerToken = readBearer(req.header("authorization"));
      const token = bearerToken ?? cookieToken;
      if (!token) {
        throw new AppError(401, "AUTH_REQUIRED", "Authentication is required");
      }
      req.pactSession = await sessions.verify(token);
      req.pactSessionAuth = bearerToken ? "bearer" : "cookie";
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireCsrfForCookieSession(req: Request, _res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }

  if (req.pactSessionAuth !== "cookie") {
    next();
    return;
  }

  const expected = req.pactSession?.csrfToken;
  const actual = req.header("x-csrf-token");
  if (!expected || actual !== expected) {
    next(new AppError(403, "CSRF_REQUIRED", "A valid CSRF token is required"));
    return;
  }

  next();
}

export function sessionCookie(token: string, config: AppConfig) {
  const attributes = [
    `${pactSessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Max-Age=28800"
  ];
  if (config.env === "production") {
    attributes.push("SameSite=None", "Secure");
  } else {
    attributes.push("SameSite=Lax");
  }
  return attributes.join("; ");
}

function readBearer(header: string | undefined) {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function readSessionCookie(cookieHeader: string | undefined) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === pactSessionCookieName) {
      return decodeURIComponent(valueParts.join("="));
    }
  }
  return undefined;
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
      pactSessionAuth?: "cookie" | "bearer";
    }
  }
}
