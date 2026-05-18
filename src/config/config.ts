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
  PACT_ALLOW_LEGACY_LTI_PATHS: booleanEnvSchema(true),
  CORS_ORIGINS: z.string().default(""),
  AGS_AUTO_RETRY_ENABLED: booleanEnvSchema(true),
  AGS_AUTO_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
  AGS_AUTO_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().min(1000).default(30000),
  AGS_AUTO_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1000).default(300000),
  AGS_ATTEMPT_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  AGS_RETENTION_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(60000).default(86400000),
  AGS_RETRY_EXHAUSTED_WEBHOOK_URLS: z.string().default(""),
  AGS_RETRY_EXHAUSTED_WEBHOOK_BEARER_TOKEN: z.string().min(1).optional(),
  AGS_RETRY_EXHAUSTED_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  AGS_RETRY_EXHAUSTED_WEBHOOK_INITIAL_DELAY_MS: z.coerce.number().int().min(1000).default(60000),
  AGS_RETRY_EXHAUSTED_WEBHOOK_MAX_DELAY_MS: z.coerce.number().int().min(1000).default(3600000),
  AGS_PROCESS_DUE_SCHEDULER_SECRET: optionalTrimmedString(16),
  STORAGE_PROVIDER: z.enum(["cloudflare"]).optional(),
  R2_ENDPOINT: z.string().url().optional(),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_BUCKET_NAME: z.string().min(1).optional(),
  R2_PUBLIC_BASE_URL: z.string().url().optional(),
  R2_DECKS_PREFIX: z.string().optional(),
  LINEAR_API_KEY: optionalTrimmedString(1),
  LINEAR_BUG_SYNC_ENABLED: booleanEnvSchema(false),
  LINEAR_TEAM_KEY: optionalTrimmedString(1),
  LINEAR_PROJECT_NAME: optionalTrimmedString(1),
  LINEAR_WEBHOOK_SECRET: optionalTrimmedString(16)
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
  pactAllowLegacyLtiPaths: boolean;
  corsOrigins: string[];
  agsAutoRetryEnabled: boolean;
  agsAutoRetryMaxAttempts: number;
  agsAutoRetryInitialDelayMs: number;
  agsAutoRetryMaxDelayMs: number;
  agsAttemptRetentionDays: number;
  agsRetentionCleanupIntervalMs: number;
  agsRetryExhaustedWebhookUrls: string[];
  agsRetryExhaustedWebhookBearerToken?: string;
  agsRetryExhaustedWebhookMaxAttempts: number;
  agsRetryExhaustedWebhookInitialDelayMs: number;
  agsRetryExhaustedWebhookMaxDelayMs: number;
  agsProcessDueSchedulerSecret?: string;
  storageProvider?: "cloudflare";
  r2Endpoint?: string;
  r2AccountId?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2BucketName?: string;
  r2PublicBaseUrl?: string;
  r2DecksPrefix?: string;
  linearApiKey?: string;
  linearBugSyncEnabled: boolean;
  linearTeamKey?: string;
  linearProjectName?: string;
  linearWebhookSecret?: string;
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
  if (parsed.LINEAR_BUG_SYNC_ENABLED && (!parsed.LINEAR_API_KEY || !parsed.LINEAR_TEAM_KEY)) {
    throw new Error("LINEAR_API_KEY and LINEAR_TEAM_KEY are required when LINEAR_BUG_SYNC_ENABLED is true.");
  }
  const r2AccountId = parsed.R2_ACCOUNT_ID ?? accountIdFromR2Endpoint(parsed.R2_ENDPOINT);
  const r2BucketName = parsed.R2_BUCKET_NAME ?? parsed.R2_BUCKET;

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
    pactAllowLegacyLtiPaths: parsed.PACT_ALLOW_LEGACY_LTI_PATHS,
    corsOrigins: parsed.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    agsAutoRetryEnabled: parsed.AGS_AUTO_RETRY_ENABLED,
    agsAutoRetryMaxAttempts: parsed.AGS_AUTO_RETRY_MAX_ATTEMPTS,
    agsAutoRetryInitialDelayMs: parsed.AGS_AUTO_RETRY_INITIAL_DELAY_MS,
    agsAutoRetryMaxDelayMs: Math.max(parsed.AGS_AUTO_RETRY_INITIAL_DELAY_MS, parsed.AGS_AUTO_RETRY_MAX_DELAY_MS),
    agsAttemptRetentionDays: parsed.AGS_ATTEMPT_RETENTION_DAYS,
    agsRetentionCleanupIntervalMs: parsed.AGS_RETENTION_CLEANUP_INTERVAL_MS,
    agsRetryExhaustedWebhookUrls: parsed.AGS_RETRY_EXHAUSTED_WEBHOOK_URLS.split(",").map((url) => url.trim()).filter(Boolean),
    agsRetryExhaustedWebhookBearerToken: parsed.AGS_RETRY_EXHAUSTED_WEBHOOK_BEARER_TOKEN,
    agsRetryExhaustedWebhookMaxAttempts: parsed.AGS_RETRY_EXHAUSTED_WEBHOOK_MAX_ATTEMPTS,
    agsRetryExhaustedWebhookInitialDelayMs: parsed.AGS_RETRY_EXHAUSTED_WEBHOOK_INITIAL_DELAY_MS,
    agsRetryExhaustedWebhookMaxDelayMs: Math.max(parsed.AGS_RETRY_EXHAUSTED_WEBHOOK_INITIAL_DELAY_MS, parsed.AGS_RETRY_EXHAUSTED_WEBHOOK_MAX_DELAY_MS),
    agsProcessDueSchedulerSecret: parsed.AGS_PROCESS_DUE_SCHEDULER_SECRET,
    storageProvider: parsed.STORAGE_PROVIDER,
    r2Endpoint: parsed.R2_ENDPOINT?.replace(/\/$/, ""),
    r2AccountId,
    r2AccessKeyId: parsed.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: parsed.R2_SECRET_ACCESS_KEY,
    r2BucketName,
    r2PublicBaseUrl: parsed.R2_PUBLIC_BASE_URL?.replace(/\/$/, ""),
    r2DecksPrefix: parsed.R2_DECKS_PREFIX,
    linearApiKey: parsed.LINEAR_API_KEY,
    linearBugSyncEnabled: parsed.LINEAR_BUG_SYNC_ENABLED,
    linearTeamKey: parsed.LINEAR_TEAM_KEY,
    linearProjectName: parsed.LINEAR_PROJECT_NAME,
    linearWebhookSecret: parsed.LINEAR_WEBHOOK_SECRET
  };
}

function accountIdFromR2Endpoint(endpoint: string | undefined) {
  if (!endpoint) return undefined;
  const hostname = new URL(endpoint).hostname;
  const suffix = ".r2.cloudflarestorage.com";
  if (!hostname.endsWith(suffix)) {
    throw new Error("R2_ENDPOINT must use a Cloudflare R2 endpoint hostname.");
  }
  const accountId = hostname.slice(0, -suffix.length);
  return accountId || undefined;
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

function booleanEnvSchema(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined) return defaultValue;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
    return value;
  }, z.boolean());
}

function optionalTrimmedString(minLength: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }, z.string().min(minLength).optional());
}
