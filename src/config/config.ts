import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4100),
  APP_BASE_URL: z.string().url(),
  MONGO_URI: z.string().min(1).optional(),
  MONGODB_URI: z.string().min(1).optional(),
  MONGO_DB_NAME: z.string().min(1).optional(),
  MONGODB_DB: z.string().min(1).optional(),
  MONGO_COLLECTION_PREFIX: z.string().optional(),
  MONGO_TLS_CERT_KEY_FILE: z.string().optional(),
  MONGODB_X509_CERT_PATH: z.string().optional(),
  LMS_API_BASE_URL: z.string().url(),
  LMS_PLATFORM_ISSUER: z.string().url(),
  LMS_PLATFORM_JWKS_URI: z.string().url(),
  LMS_DEEP_LINK_RETURN_URL: z.string().url(),
  PACT_LTI_CLIENT_ID: z.string().min(1),
  PACT_LTI_DEPLOYMENT_IDS: z.string().min(1),
  PACT_SESSION_SECRET: z.string().min(16),
  PACT_TOOL_KID: z.string().min(1).optional(),
  PACT_TOOL_PRIVATE_KEY_PEM: z.string().optional(),
  CORS_ORIGINS: z.string().default("")
});

export type AppConfig = {
  env: "development" | "test" | "production";
  port: number;
  appBaseUrl: string;
  mongoUri: string;
  mongoDbName: string;
  mongoCollectionPrefix: string;
  mongoTlsCertKeyFile?: string;
  lmsApiBaseUrl: string;
  lmsPlatformIssuer: string;
  lmsPlatformJwksUri: string;
  lmsDeepLinkReturnUrl: string;
  pactLtiClientId: string;
  pactLtiDeploymentIds: string[];
  pactSessionSecret: string;
  pactToolKid?: string;
  pactToolPrivateKeyPem?: string;
  corsOrigins: string[];
};

export function loadConfig(source: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.parse(source);
  const mongoUri = parsed.MONGODB_URI ?? parsed.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI or MONGODB_URI is required");
  }

  return {
    env: parsed.NODE_ENV,
    port: parsed.PORT,
    appBaseUrl: parsed.APP_BASE_URL.replace(/\/$/, ""),
    mongoUri,
    mongoDbName: parsed.MONGODB_DB ?? parsed.MONGO_DB_NAME ?? "PACT_V4",
    mongoCollectionPrefix: parsed.MONGO_COLLECTION_PREFIX ?? (parsed.NODE_ENV === "production" ? "" : "pact_dev_"),
    mongoTlsCertKeyFile: parsed.MONGODB_X509_CERT_PATH ?? parsed.MONGO_TLS_CERT_KEY_FILE,
    lmsApiBaseUrl: parsed.LMS_API_BASE_URL.replace(/\/$/, ""),
    lmsPlatformIssuer: parsed.LMS_PLATFORM_ISSUER.replace(/\/$/, ""),
    lmsPlatformJwksUri: parsed.LMS_PLATFORM_JWKS_URI,
    lmsDeepLinkReturnUrl: parsed.LMS_DEEP_LINK_RETURN_URL,
    pactLtiClientId: parsed.PACT_LTI_CLIENT_ID,
    pactLtiDeploymentIds: parsed.PACT_LTI_DEPLOYMENT_IDS.split(",").map((value) => value.trim()).filter(Boolean),
    pactSessionSecret: parsed.PACT_SESSION_SECRET,
    pactToolKid: parsed.PACT_TOOL_KID,
    pactToolPrivateKeyPem: parsed.PACT_TOOL_PRIVATE_KEY_PEM?.replace(/\\n/g, "\n"),
    corsOrigins: parsed.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
  };
}
