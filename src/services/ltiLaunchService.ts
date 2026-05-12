import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AppConfig } from "../config/config.js";
import type { PactRole } from "../domain/types.js";
import { AppError } from "../errors/AppError.js";
import { PactRepository } from "../repositories/pactRepository.js";
import { SessionService } from "../auth/sessionService.js";

type LtiLaunchPayload = JWTPayload & {
  name?: string;
  email?: string;
  given_name?: string;
  family_name?: string;
  "https://purl.imsglobal.org/spec/lti/claim/message_type"?: string;
  "https://purl.imsglobal.org/spec/lti/claim/deployment_id"?: string;
  "https://purl.imsglobal.org/spec/lti/claim/roles"?: string[];
  "https://purl.imsglobal.org/spec/lti/claim/context"?: { id?: string; label?: string; title?: string };
  "https://purl.imsglobal.org/spec/lti/claim/custom"?: Record<string, string>;
  "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint"?: {
    lineitems?: string;
    lineitem?: string;
    scope?: string[];
  };
  "https://purl.imsglobal.org/spec/lti/claim/resource_link"?: { id?: string; title?: string };
};

export class LtiLaunchService {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly sessions: SessionService;

  constructor(private readonly config: AppConfig, private readonly repository: PactRepository) {
    this.jwks = createRemoteJWKSet(new URL(config.lmsPlatformJwksUri));
    this.sessions = new SessionService(config.pactSessionSecret);
  }

  async handleLaunch(idToken: string) {
    const { payload } = await jwtVerify<LtiLaunchPayload>(idToken, this.jwks, {
      issuer: this.config.lmsPlatformIssuer,
      audience: this.config.pactLtiClientId
    });

    if (payload["https://purl.imsglobal.org/spec/lti/claim/message_type"] !== "LtiResourceLinkRequest") {
      throw new AppError(400, "INVALID_LTI_MESSAGE", "Unsupported LTI message type");
    }

    const deploymentId = payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"];
    if (!deploymentId || !this.config.pactLtiDeploymentIds.includes(deploymentId)) {
      throw new AppError(401, "INVALID_DEPLOYMENT", "LTI deployment is not trusted");
    }

    const sub = payload.sub;
    if (!sub) throw new AppError(401, "INVALID_LTI_SUBJECT", "LTI launch is missing subject");

    const custom = payload["https://purl.imsglobal.org/spec/lti/claim/custom"] ?? {};
    const context = payload["https://purl.imsglobal.org/spec/lti/claim/context"];
    const courseId = custom.course_id ?? context?.label ?? context?.id ?? "pact";
    const cohortId = custom.cohort_id ?? context?.id;
    if (!cohortId) throw new AppError(400, "COHORT_REQUIRED", "LTI launch must include a cohort context");

    const user = await this.repository.upsertUser({
      lmsUserId: sub,
      email: payload.email,
      name: payload.name ?? ([payload.given_name, payload.family_name].filter(Boolean).join(" ") || undefined),
      role: normalizeRole(payload["https://purl.imsglobal.org/spec/lti/claim/roles"] ?? []),
      courseId,
      cohortId,
      squadId: custom.squad_id
    });

    const sessionToken = await this.sessions.sign({
      userId: user.id,
      role: user.role,
      courseId: user.courseId,
      cohortId: user.cohortId,
      squadId: user.squadId
    });

    return {
      sessionToken,
      user,
      ags: payload["https://purl.imsglobal.org/spec/lti-ags/claim/endpoint"],
      resourceLink: payload["https://purl.imsglobal.org/spec/lti/claim/resource_link"]
    };
  }
}

function normalizeRole(roles: string[]): PactRole {
  const joined = roles.join(" ").toLowerCase();
  if (joined.includes("administrator") || joined.includes("admin")) return "admin";
  if (joined.includes("instructor")) return "instructor";
  return "learner";
}
