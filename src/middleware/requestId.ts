import type { NextFunction, Request, Response } from "express";

export function requestId(req: Request, res: Response, next: NextFunction) {
  const existing = req.header("x-request-id");
  req.requestId = existing && existing.length <= 128 ? existing : crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}
