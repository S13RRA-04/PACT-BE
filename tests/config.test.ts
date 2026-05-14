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
});
