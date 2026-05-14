import { importPKCS8, SignJWT } from "jose";
import type { AppConfig } from "../config/config.js";
import { AppError } from "../errors/AppError.js";

const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export class LmsTokenClient {
  constructor(private readonly config: AppConfig) {}

  async getAgsAccessToken(scopes: string[]) {
    if (!this.config.pactToolPrivateKeyPem || !this.config.pactToolKid) {
      throw new AppError(500, "PACT_TOOL_KEY_MISSING", "PACT tool signing key is not configured");
    }

    const tokenUrl = `${this.config.lmsApiBaseUrl}/api/v1/lti/token`;
    const assertion = await this.createClientAssertion(tokenUrl);
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion
    });
    if (scopes.length) body.set("scope", scopes.join(" "));

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!response.ok) {
      throw new AppError(502, "AGS_TOKEN_REQUEST_FAILED", "LMS AGS token request failed");
    }

    const payload = await response.json() as { access_token?: unknown; scope?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== "string") {
      throw new AppError(502, "AGS_TOKEN_RESPONSE_INVALID", "LMS AGS token response was invalid");
    }
    return {
      accessToken: payload.access_token,
      scope: typeof payload.scope === "string" ? payload.scope : scopes.join(" "),
      expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : undefined
    };
  }

  private async createClientAssertion(audience: string) {
    const key = await importPKCS8(this.config.pactToolPrivateKeyPem!, "RS256");
    return new SignJWT({ jti: crypto.randomUUID() })
      .setProtectedHeader({ alg: "RS256", kid: this.config.pactToolKid })
      .setIssuer(this.config.pactLtiClientId)
      .setSubject(this.config.pactLtiClientId)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  }
}
