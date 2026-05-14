import { jwtVerify, SignJWT } from "jose";
import type { ContentType, PactRole } from "../domain/types.js";
import { AppError } from "../errors/AppError.js";

export type PactSession = {
  userId: string;
  role: PactRole;
  courseId: string;
  cohortId: string;
  squadId?: string;
  contentType?: ContentType;
};

export class SessionService {
  private readonly secret: Uint8Array;

  constructor(secret: string) {
    this.secret = new TextEncoder().encode(secret);
  }

  async sign(session: PactSession) {
    return new SignJWT(session)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("8h")
      .sign(this.secret);
  }

  async verify(token: string): Promise<PactSession> {
    const { payload } = await jwtVerify(token, this.secret);
    if (!payload.userId || !payload.role || !payload.courseId || !payload.cohortId) {
      throw new AppError(401, "INVALID_SESSION", "PACT session token is invalid");
    }
    return {
      userId: String(payload.userId),
      role: payload.role as PactRole,
      courseId: String(payload.courseId),
      cohortId: String(payload.cohortId),
      squadId: payload.squadId ? String(payload.squadId) : undefined,
      contentType: isContentType(payload.contentType) ? payload.contentType : undefined
    };
  }
}

function isContentType(value: unknown): value is ContentType {
  return value === "module" || value === "challenge" || value === "game" || value === "assessment";
}
