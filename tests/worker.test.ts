import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";

describe("PACT Worker proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows browser CSRF headers for cookie-backed PACT sessions", async () => {
    const response = await worker.fetch(
      new Request("https://pact2-api.cetu.online/api/v1/bug-reports", {
        method: "OPTIONS",
        headers: {
          origin: "https://pact2.cetu.online",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-csrf-token"
        }
      }),
      {
        PACT_API_ORIGIN: "https://pact-api-origin.cetu.online",
        CORS_ORIGINS: "https://pact2.cetu.online"
      }
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://pact2.cetu.online");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-csrf-token");
  });

  it("rejects origin configuration that points back at the Worker host", async () => {
    const response = await worker.fetch(
      new Request("https://pact2-api.cetu.online/api/v1/lti/jwks"),
      {
        PACT_API_ORIGIN: "https://pact2-api.cetu.online",
        CORS_ORIGINS: "https://pact2.cetu.online"
      }
    );

    expect(response.status).toBe(508);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PACT_ORIGIN_LOOP" }
    });
  });

  it("preserves CORS headers on proxied admin POST failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: { code: "CSRF_REQUIRED", message: "CSRF token is required" } }, { status: 403 })
    );

    const response = await worker.fetch(
      new Request("https://pact2-api.cetu.online/api/v1/admin/diagnostics/ags-publish-attempts/process-due", {
        method: "POST",
        headers: {
          origin: "https://pact2.cetu.online",
          "content-type": "application/json",
          "x-csrf-token": "csrf-token"
        },
        body: "{}"
      }),
      {
        PACT_API_ORIGIN: "https://pact-api-origin.cetu.online",
        CORS_ORIGINS: "https://pact2.cetu.online"
      }
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://pact2.cetu.online");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
