import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4100),
  APP_BASE_URL: z.string().url(),
  MONGO_URI: z.string().min(1).optional(),
  MONGODB_URI: z.string().min(1).optional(),
  MONGO_USERNAME: z.string().min(1).optional(),
  MONGO_PASSWORD: z.string().min(1).optional(),
  MONGO_DB_NAME: z.string().min(1).optional(),
  MONGODB_DB: z.string().min(1).optional(),
  MONGO_COLLECTION_PREFIX: z.string().optional(),
  LMS_API_BASE_URL: z.string().url(),
  LMS_PLATFORM_ISSUER: z.string().url(),
  LMS_PLATFORM_JWKS_URI: z.string().url(),
  LMS_DEEP_LINK_RETURN_URL: z.string().url(),
  PACT_WEB_BASE_URL: z.string().url().optional(),
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
  lmsApiBaseUrl: string;
  lmsPlatformIssuer: string;
  lmsPlatformJwksUri: string;
  lmsDeepLinkReturnUrl: string;
  pactWebBaseUrl: string;
  pactLtiClientId: string;
  pactLtiDeploymentIds: string[];
  pactSessionSecret: string;
  pactToolKid?: string;
  pactToolPrivateKeyPem?: string;
  corsOrigins: string[];
};

export function loadConfig(source: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.parse(source);
  const configuredMongoUri = parsed.MONGODB_URI ?? parsed.MONGO_URI;
  if (!configuredMongoUri) {
    throw new Error("MONGO_URI or MONGODB_URI is required");
  }
  const mongoUri = buildMongoUri(configuredMongoUri, parsed.MONGO_USERNAME, parsed.MONGO_PASSWORD);
  assertWorkerCompatibleMongoUri(mongoUri, parsed.NODE_ENV);

  const mongoCollectionPrefix = parsed.MONGO_COLLECTION_PREFIX === "__empty__"
    ? ""
    : parsed.MONGO_COLLECTION_PREFIX ?? (parsed.NODE_ENV === "production" ? "" : "pact_dev_");
  const mongoDbName = parsed.MONGODB_DB ?? parsed.MONGO_DB_NAME ?? "PACT_V4";
  assertPactMongoDatabaseName(mongoDbName);

  return {
    env: parsed.NODE_ENV,
    port: parsed.PORT,
    appBaseUrl: parsed.APP_BASE_URL.replace(/\/$/, ""),
    mongoUri,
    mongoDbName,
    mongoCollectionPrefix,
    lmsApiBaseUrl: parsed.LMS_API_BASE_URL.replace(/\/$/, ""),
    lmsPlatformIssuer: parsed.LMS_PLATFORM_ISSUER.replace(/\/$/, ""),
    lmsPlatformJwksUri: parsed.LMS_PLATFORM_JWKS_URI,
    lmsDeepLinkReturnUrl: parsed.LMS_DEEP_LINK_RETURN_URL,
    pactWebBaseUrl: (parsed.PACT_WEB_BASE_URL ?? parsed.APP_BASE_URL).replace(/\/$/, ""),
    pactLtiClientId: parsed.PACT_LTI_CLIENT_ID,
    pactLtiDeploymentIds: parsed.PACT_LTI_DEPLOYMENT_IDS.split(",").map((value) => value.trim()).filter(Boolean),
    pactSessionSecret: parsed.PACT_SESSION_SECRET,
    pactToolKid: parsed.PACT_TOOL_KID,
    pactToolPrivateKeyPem: parsed.PACT_TOOL_PRIVATE_KEY_PEM?.replace(/\\n/g, "\n"),
    corsOrigins: parsed.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
  };
}

function buildMongoUri(mongoUri: string, username?: string, password?: string) {
  if (!username && !password) {
    return mongoUri;
  }

  if (!username || !password) {
    throw new Error("MONGO_USERNAME and MONGO_PASSWORD must both be set when either one is provided.");
  }

  return mongoUri.replace(
    /^(mongodb(?:\+srv)?:\/\/)(?:[^@/?]+@)?(.+)$/i,
    (_match, prefix: string, rest: string) => `${prefix}${encodeURIComponent(username)}:${encodeURIComponent(password)}@${rest}`
  );
}

function assertWorkerCompatibleMongoUri(mongoUri: string, nodeEnv: "development" | "test" | "production") {
  if (/authMechanism=MONGODB-X509|authMechanism=%24external|authSource=%24external/i.test(mongoUri)) {
    throw new Error("MONGO_URI must use MongoDB database-user credentials for Cloudflare Worker-compatible deployments; X.509 certificate-file auth is not supported.");
  }

  if (nodeEnv === "production" && !isLoopbackMongoUri(mongoUri) && !/^mongodb(\+srv)?:\/\/[^:/@]+:[^@]+@/i.test(mongoUri)) {
    throw new Error("MONGO_URI must include MongoDB database-user credentials.");
  }
}

function isLoopbackMongoUri(mongoUri: string) {
  try {
    const url = new URL(mongoUri);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function assertPactMongoDatabaseName(databaseName: string) {
  const normalized = normalizeDatabaseName(databaseName);
  if (!normalized.includes("pact")) {
    throw new Error("PACT MONGO_DB_NAME must be PACT-specific and must not point at the LMS or Keycloak database.");
  }
  if (normalized.includes("keycloak") || normalized === "lms" || normalized === "cetu") {
    throw new Error("PACT MONGO_DB_NAME must not point at the LMS or Keycloak database.");
  }
}

function normalizeDatabaseName(databaseName: string) {
  return databaseName.toLowerCase().replace(/[^a-z0-9]/g, "");
}
