process.env.DOTENV_CONFIG_PATH = process.env.DOTENV_CONFIG_PATH ?? ".env.pact-origin-runtime";
await import("dotenv/config");

process.env.NODE_ENV = "production";
process.env.PORT = "4200";
process.env.APP_BASE_URL = "https://pact2-api.cetu.online";
process.env.PACT_WEB_BASE_URL = "https://pact2.cetu.online";
process.env.LMS_API_BASE_URL = "https://lms-api.cetu.online";
process.env.LMS_PLATFORM_ISSUER = "https://lms-api.cetu.online";
process.env.LMS_PLATFORM_JWKS_URI = "https://lms-api.cetu.online/api/v1/lti/jwks";
process.env.LMS_DEEP_LINK_RETURN_URL = "https://lms-api.cetu.online/api/v1/lti/deep-linking/return";
process.env.CORS_ORIGINS = "https://pact2.cetu.online,https://lms.cetu.online";
process.env.MONGO_COLLECTION_PREFIX = "";

await import("./importPactModules.js");
