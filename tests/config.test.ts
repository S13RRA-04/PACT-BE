import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";

describe("config", () => {
  it("supports an explicit empty Mongo collection prefix for production PowerShell scripts", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      APP_BASE_URL: "https://pact2-api.cetu.online",
      MONGO_URI: "mongodb://user:password@localhost:27017",
      LMS_API_BASE_URL: "https://lms-api.cetu.online",
      LMS_PLATFORM_ISSUER: "https://lms-api.cetu.online",
      LMS_PLATFORM_JWKS_URI: "https://lms-api.cetu.online/api/v1/lti/jwks",
      LMS_DEEP_LINK_RETURN_URL: "https://lms-api.cetu.online/api/v1/lti/deep-linking/return",
      PACT_LTI_CLIENT_ID: "pact-tool",
      PACT_LTI_DEPLOYMENT_IDS: "pact-course-deployment",
      PACT_SESSION_SECRET: "test-secret-with-enough-length",
      MONGO_COLLECTION_PREFIX: "__empty__"
    });

    expect(config.mongoCollectionPrefix).toBe("");
  });

  it("parses AGS retry exhausted notification sinks", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      APP_BASE_URL: "https://pact2-api.cetu.online",
      MONGO_URI: "mongodb://user:password@localhost:27017",
      LMS_API_BASE_URL: "https://lms-api.cetu.online",
      LMS_PLATFORM_ISSUER: "https://lms-api.cetu.online",
      LMS_PLATFORM_JWKS_URI: "https://lms-api.cetu.online/api/v1/lti/jwks",
      LMS_DEEP_LINK_RETURN_URL: "https://lms-api.cetu.online/api/v1/lti/deep-linking/return",
      PACT_LTI_CLIENT_ID: "pact-tool",
      PACT_LTI_DEPLOYMENT_IDS: "pact-course-deployment",
      PACT_SESSION_SECRET: "test-secret-with-enough-length",
      AGS_RETRY_EXHAUSTED_WEBHOOK_URLS: "https://ops.example.test/ags, https://backup.example.test/ags",
      AGS_RETRY_EXHAUSTED_WEBHOOK_BEARER_TOKEN: "notification-token",
      AGS_RETRY_EXHAUSTED_WEBHOOK_MAX_ATTEMPTS: "7",
      AGS_RETRY_EXHAUSTED_WEBHOOK_INITIAL_DELAY_MS: "5000",
      AGS_RETRY_EXHAUSTED_WEBHOOK_MAX_DELAY_MS: "60000"
    });

    expect(config.agsRetryExhaustedWebhookUrls).toEqual(["https://ops.example.test/ags", "https://backup.example.test/ags"]);
    expect(config.agsRetryExhaustedWebhookBearerToken).toBe("notification-token");
    expect(config.agsRetryExhaustedWebhookMaxAttempts).toBe(7);
    expect(config.agsRetryExhaustedWebhookInitialDelayMs).toBe(5000);
    expect(config.agsRetryExhaustedWebhookMaxDelayMs).toBe(60000);
  });

  it("can disable legacy LTI target link paths after registrations migrate", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      APP_BASE_URL: "https://pact2-api.cetu.online",
      MONGO_URI: "mongodb://user:password@localhost:27017",
      LMS_API_BASE_URL: "https://lms-api.cetu.online",
      LMS_PLATFORM_ISSUER: "https://lms-api.cetu.online",
      LMS_PLATFORM_JWKS_URI: "https://lms-api.cetu.online/api/v1/lti/jwks",
      LMS_DEEP_LINK_RETURN_URL: "https://lms-api.cetu.online/api/v1/lti/deep-linking/return",
      PACT_LTI_CLIENT_ID: "pact-tool",
      PACT_LTI_DEPLOYMENT_IDS: "pact-course-deployment",
      PACT_SESSION_SECRET: "test-secret-with-enough-length",
      PACT_ALLOW_LEGACY_LTI_PATHS: "false"
    });

    expect(config.pactAllowLegacyLtiPaths).toBe(false);
  });

  it("parses the external AGS process-due scheduler secret", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      APP_BASE_URL: "https://pact2-api.cetu.online",
      MONGO_URI: "mongodb://user:password@localhost:27017",
      LMS_API_BASE_URL: "https://lms-api.cetu.online",
      LMS_PLATFORM_ISSUER: "https://lms-api.cetu.online",
      LMS_PLATFORM_JWKS_URI: "https://lms-api.cetu.online/api/v1/lti/jwks",
      LMS_DEEP_LINK_RETURN_URL: "https://lms-api.cetu.online/api/v1/lti/deep-linking/return",
      PACT_LTI_CLIENT_ID: "pact-tool",
      PACT_LTI_DEPLOYMENT_IDS: "pact-course-deployment",
      PACT_SESSION_SECRET: "test-secret-with-enough-length",
      AGS_PROCESS_DUE_SCHEDULER_SECRET: "scheduler-secret-with-enough-length"
    });

    expect(config.agsProcessDueSchedulerSecret).toBe("scheduler-secret-with-enough-length");
  });

  it("parses Cloudflare R2 endpoint-style storage configuration", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      APP_BASE_URL: "https://pact2-api.cetu.online",
      MONGO_URI: "mongodb://user:password@localhost:27017",
      LMS_API_BASE_URL: "https://lms-api.cetu.online",
      LMS_PLATFORM_ISSUER: "https://lms-api.cetu.online",
      LMS_PLATFORM_JWKS_URI: "https://lms-api.cetu.online/api/v1/lti/jwks",
      LMS_DEEP_LINK_RETURN_URL: "https://lms-api.cetu.online/api/v1/lti/deep-linking/return",
      PACT_LTI_CLIENT_ID: "pact-tool",
      PACT_LTI_DEPLOYMENT_IDS: "pact-course-deployment",
      PACT_SESSION_SECRET: "test-secret-with-enough-length",
      STORAGE_PROVIDER: "cloudflare",
      R2_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
      R2_BUCKET: "pact",
      R2_ACCESS_KEY_ID: "access-key",
      R2_SECRET_ACCESS_KEY: "secret-key",
      R2_PUBLIC_BASE_URL: "https://pact-storage.example.test",
      R2_DECKS_PREFIX: "decks/"
    });

    expect(config.storageProvider).toBe("cloudflare");
    expect(config.r2Endpoint).toBe("https://account-id.r2.cloudflarestorage.com");
    expect(config.r2AccountId).toBe("account-id");
    expect(config.r2BucketName).toBe("pact");
    expect(config.r2PublicBaseUrl).toBe("https://pact-storage.example.test");
    expect(config.r2DecksPrefix).toBe("decks/");
  });

  it("rejects LMS or Keycloak database names for PACT persistence", () => {
    const baseEnv = {
      NODE_ENV: "production",
      APP_BASE_URL: "https://pact2-api.cetu.online",
      MONGO_URI: "mongodb://user:password@localhost:27017",
      LMS_API_BASE_URL: "https://lms-api.cetu.online",
      LMS_PLATFORM_ISSUER: "https://lms-api.cetu.online",
      LMS_PLATFORM_JWKS_URI: "https://lms-api.cetu.online/api/v1/lti/jwks",
      LMS_DEEP_LINK_RETURN_URL: "https://lms-api.cetu.online/api/v1/lti/deep-linking/return",
      PACT_LTI_CLIENT_ID: "pact-tool",
      PACT_LTI_DEPLOYMENT_IDS: "pact-course-deployment",
      PACT_SESSION_SECRET: "test-secret-with-enough-length"
    };

    expect(() => loadConfig({ ...baseEnv, MONGO_DB_NAME: "LMS" })).toThrow(/PACT MONGO_DB_NAME/);
    expect(() => loadConfig({ ...baseEnv, MONGO_DB_NAME: "keycloak" })).toThrow(/PACT MONGO_DB_NAME/);
    expect(loadConfig({ ...baseEnv, MONGO_DB_NAME: "PACT_V4" }).mongoDbName).toBe("PACT_V4");
  });
});
