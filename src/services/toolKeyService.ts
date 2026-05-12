import { createPrivateKey, createPublicKey } from "node:crypto";
import { exportJWK, importSPKI } from "jose";
import type { AppConfig } from "../config/config.js";
import { AppError } from "../errors/AppError.js";

export class ToolKeyService {
  constructor(private readonly config: AppConfig) {}

  async jwks() {
    if (!this.config.pactToolPrivateKeyPem || !this.config.pactToolKid) {
      throw new AppError(500, "PACT_TOOL_KEY_MISSING", "PACT tool signing key is not configured");
    }

    const publicKey = createPublicKey(createPrivateKey(this.config.pactToolPrivateKeyPem)).export({ type: "spki", format: "pem" });
    const jwk = await exportJWK(await importSPKI(publicKey.toString(), "RS256"));
    return { keys: [{ ...jwk, kid: this.config.pactToolKid, alg: "RS256", use: "sig" }] };
  }
}
