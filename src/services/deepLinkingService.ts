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
    const launch = await new LtiLaunchService(this.config, this.repository).verifyDeepLinkLaunch(idToken);
    const returnUrl = launch.deepLinkingSettings.deep_link_return_url;

    if (returnUrl !== this.config.lmsDeepLinkReturnUrl) {
      throw new AppError(400, "INVALID_DEEP_LINK_RETURN_URL", "Deep Linking return URL is not trusted");
    }

    const contentItems = [
      contentItem("pact-module-hub", "PACT Modules", `${this.config.appBaseUrl}/launch/module`, 100, "module"),
      contentItem("pact-challenge-hub", "PACT Squad Challenges", `${this.config.appBaseUrl}/launch/challenge`, 100, "challenge"),
      contentItem("pact-game-hub", "PACT Games", `${this.config.appBaseUrl}/launch/game`, 100, "game")
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

    return renderFormPost(returnUrl, { JWT: jwt });
  }
}

function contentItem(resourceId: string, title: string, url: string, scoreMaximum: number, tag: string) {
  return {
    type: "ltiResourceLink",
    title,
    url,
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
