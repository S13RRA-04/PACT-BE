import { importPKCS8, SignJWT } from "jose";
import type { AppConfig } from "../config/config.js";
import { AppError } from "../errors/AppError.js";
import { LtiLaunchService } from "./ltiLaunchService.js";
import { PactRepository } from "../repositories/pactRepository.js";

const claims = {
  messageType: "https://purl.imsglobal.org/spec/lti/claim/message_type",
  version: "https://purl.imsglobal.org/spec/lti/claim/version",
  contentItems: "https://purl.imsglobal.org/spec/lti-dl/claim/content_items",
  deepLinkingSettings: "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings",
  custom: "https://purl.imsglobal.org/spec/lti/claim/custom"
} as const;

export class DeepLinkingService {
  constructor(private readonly config: AppConfig, private readonly repository: PactRepository) {}

  async createDeepLinkResponse(idToken: string) {
    const response = await this.createDeepLinkResponsePayload(idToken);
    return renderFormPost(response.returnUrl, { JWT: response.jwt });
  }

  async createDeepLinkResponsePayload(idToken: string) {
    const launch = await new LtiLaunchService(this.config, this.repository).verifyDeepLinkLaunch(idToken);
    const returnUrl = launch.deepLinkingSettings.deep_link_return_url;

    if (returnUrl !== this.config.lmsDeepLinkReturnUrl) {
      throw new AppError(400, "INVALID_DEEP_LINK_RETURN_URL", "Deep Linking return URL is not trusted");
    }

    const context = parseDeepLinkData(launch.deepLinkingSettings.data);
    const labels = await this.repository.listLmsLabelsForDeepLink(context.courseId);
    const directAssessmentItems = (await this.repository.listDeepLinkableContent(context.courseId))
      .map((content) => contentItem(
        content.id,
        content.lmsLabel ?? content.title,
        `${this.config.appBaseUrl}/launch/${content.type}?contentId=${encodeURIComponent(content.id)}`,
        content.maxScore,
        content.type,
        { content_id: content.id }
      ));
    const contentItems = [
      contentItem("pact-module-hub", labels.module ?? "PACT Modules", `${this.config.appBaseUrl}/launch/module`, 100, "module"),
      contentItem("pact-challenge-hub", labels.challenge ?? "PACT Challenges", `${this.config.appBaseUrl}/launch/challenge`, 100, "challenge"),
      contentItem("pact-workshop-hub", labels.workshop ?? "PACT Workshops", `${this.config.appBaseUrl}/launch/workshop`, 100, "workshop"),
      contentItem("pact-game-hub", labels.game ?? "PACT Games", `${this.config.appBaseUrl}/launch/game`, 100, "game"),
      contentItem("pact-assessment-hub", labels.assessment ?? "PACT Assessments", `${this.config.appBaseUrl}/launch/assessment`, 100, "assessment"),
      ...directAssessmentItems
    ];

    const privateKey = this.config.pactToolPrivateKeyPem;
    const kid = this.config.pactToolKid;
    if (!privateKey || !kid) {
      throw new AppError(500, "PACT_TOOL_KEY_MISSING", "PACT tool signing key is not configured");
    }

    const jwt = await new SignJWT({
      [claims.messageType]: "LtiDeepLinkingResponse",
      [claims.version]: "1.3.0",
      [claims.contentItems]: contentItems,
      data: launch.deepLinkingSettings.data
    })
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .setIssuer(this.config.pactLtiClientId)
      .setSubject(this.config.pactLtiClientId)
      .setAudience(returnUrl)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(await importPKCS8(privateKey, "RS256"));

    return { returnUrl, jwt };
  }
}

function parseDeepLinkData(value: unknown) {
  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as { courseId?: unknown };
    return { courseId: typeof parsed.courseId === "string" ? parsed.courseId : undefined };
  } catch {
    return {};
  }
}

function contentItem(resourceId: string, title: string, url: string, scoreMaximum: number, tag: string, custom?: Record<string, string>) {
  return {
    type: "ltiResourceLink",
    title,
    url,
    ...(custom ? { custom } : {}),
    lineItem: {
      label: title,
      scoreMaximum,
      resourceId,
      tag
    }
  };
}

function renderFormPost(action: string, fields: Record<string, string>) {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>PACT Deep Link</title></head><body><form method="post" action="${escapeHtml(action)}">${inputs}</form><script>document.forms[0].submit();</script></body></html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
