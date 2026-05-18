import { describe, expect, it, vi } from "vitest";
import { listR2Documents, presignR2GetObject } from "../src/services/r2Service.js";

const r2Config = {
  endpoint: "https://account-id.r2.cloudflarestorage.com",
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
  bucketName: "pact"
};

describe("R2 service", () => {
  it("accepts bucket-prefixed document prefixes from Cloudflare paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      `<ListBucketResult>
        <Contents>
          <Key>scenarios/brokered-exit/Student/Case Files/release_R0/README.txt</Key>
          <LastModified>2026-05-18T00:00:00.000Z</LastModified>
          <Size>634</Size>
          <ETag>&quot;etag&quot;</ETag>
        </Contents>
      </ListBucketResult>`,
      { status: 200 }
    ));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const documents = await listR2Documents(r2Config, "pact/scenarios/brokered-exit/Student/Case Files/");

      expect(fetchMock).toHaveBeenCalledOnce();
      const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
      expect(requestUrl.searchParams.get("prefix")).toBe("scenarios/brokered-exit/Student/Case Files/");
      expect(documents[0]).toMatchObject({
        key: "scenarios/brokered-exit/Student/Case Files/release_R0/README.txt",
        size: 634
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("strips the bucket prefix before signing object URLs", () => {
    const url = new URL(presignR2GetObject(
      r2Config,
      "pact/scenarios/brokered-exit/Student/Case Files/release_R0/README.txt",
      { now: new Date("2026-05-18T00:00:00.000Z") }
    ));

    expect(url.pathname).toBe("/pact/scenarios/brokered-exit/Student/Case%20Files/release_R0/README.txt");
    expect(url.pathname).not.toContain("/pact/pact/");
  });

  it("orders mixed-case query parameters with SigV4 byte ordering for download URLs", () => {
    const url = new URL(presignR2GetObject(
      r2Config,
      "decks/Threat Landscape/Threat Landscape.pptx",
      {
        now: new Date("2026-05-18T00:00:00.000Z"),
        responseContentDisposition: `attachment; filename="Threat Landscape.pptx"`
      }
    ));

    const query = url.search.slice(1);
    expect(query.indexOf("X-Amz-Algorithm=")).toBeLessThan(query.indexOf("response-content-disposition="));
    expect(url.searchParams.get("response-content-disposition")).toBe(`attachment; filename="Threat Landscape.pptx"`);
  });
});
