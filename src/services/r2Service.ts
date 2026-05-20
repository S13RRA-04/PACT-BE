import { createHash, createHmac } from "node:crypto";

export type R2DocumentItem = {
  key: string;
  size: number;
  lastModified: string;
  etag?: string;
  downloadUrl: string;
};

type R2Config = {
  accountId?: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
};

const REGION = "auto";
const SERVICE = "s3";
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function sha256BytesHex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer | string, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

function signingKey(secretKey: string, date: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function isoDateTime(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
}

// Sig V4 percent-encode: encode everything except unreserved chars (A-Z a-z 0-9 - _ . ~)
function sigV4Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildCanonicalQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => [sigV4Encode(k), sigV4Encode(v)] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export async function listR2Documents(config: R2Config, prefix?: string): Promise<R2DocumentItem[]> {
  const contents: ParsedContent[] = [];
  let continuationToken: string | undefined;
  const now = new Date();

  do {
    const page = await listR2DocumentPage(config, prefix, continuationToken, now);
    contents.push(...page.contents);
    continuationToken = page.nextContinuationToken;
  } while (continuationToken);

  return contents.map((item) => ({
    ...item,
    downloadUrl: presignR2GetObject(config, item.key, { expiresIn: 3600, now })
  }));
}

async function listR2DocumentPage(config: R2Config, prefix: string | undefined, continuationToken: string | undefined, now: Date): Promise<{
  contents: ParsedContent[];
  nextContinuationToken?: string;
}> {
  const host = r2Host(config);
  const date = isoDate(now);
  const datetime = isoDateTime(now);
  const normalizedPrefix = prefix ? normalizeR2ObjectKey(config, prefix) : undefined;

  const queryParams: Record<string, string> = { "list-type": "2" };
  if (normalizedPrefix) queryParams["prefix"] = normalizedPrefix;
  if (continuationToken) queryParams["continuation-token"] = continuationToken;
  const canonicalQuery = buildCanonicalQueryString(queryParams);

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${EMPTY_HASH}\nx-amz-date:${datetime}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const path = `/${config.bucketName}`;

  const canonicalRequest = ["GET", path, canonicalQuery, canonicalHeaders, signedHeaders, EMPTY_HASH].join("\n");

  const credScope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${datetime}\n${credScope}\n${sha256Hex(canonicalRequest)}`;
  const key = signingKey(config.secretAccessKey, date);
  const signature = hmacHex(key, stringToSign);

  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${host}${path}?${canonicalQuery}`, {
    headers: {
      "host": host,
      "x-amz-content-sha256": EMPTY_HASH,
      "x-amz-date": datetime,
      "authorization": authorization
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`R2 list failed: ${response.status} ${body.slice(0, 200)}`);
  }

  const xml = await response.text();
  return {
    contents: parseContents(xml),
    nextContinuationToken: extractXml(xml, "NextContinuationToken")
  };
}

export async function putR2Object(config: R2Config, input: {
  key: string;
  body: Uint8Array;
  contentType?: string;
}) {
  const host = r2Host(config);
  const now = new Date();
  const date = isoDate(now);
  const datetime = isoDateTime(now);
  const normalizedKey = normalizeR2ObjectKey(config, input.key);
  const payloadHash = sha256BytesHex(input.body);
  const encodedKey = normalizedKey.split("/").map(sigV4Encode).join("/");
  const path = `/${config.bucketName}/${encodedKey}`;
  const contentType = input.contentType ?? "application/octet-stream";

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${datetime}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["PUT", path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credScope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${datetime}\n${credScope}\n${sha256Hex(canonicalRequest)}`;
  const key = signingKey(config.secretAccessKey, date);
  const signature = hmacHex(key, stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${host}${path}`, {
    method: "PUT",
    headers: {
      "content-type": contentType,
      "host": host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": datetime,
      "authorization": authorization
    },
    body: Buffer.from(input.body)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`R2 put failed: ${response.status} ${body.slice(0, 200)}`);
  }

  return {
    key: normalizedKey,
    etag: response.headers.get("etag") ?? undefined
  };
}

export function presignR2GetObject(config: R2Config, key: string, options: {
  expiresIn?: number;
  now?: Date;
  responseContentDisposition?: string;
} = {}): string {
  const host = r2Host(config);
  const expiresIn = options.expiresIn ?? 3600;
  const now = options.now ?? new Date();
  const date = isoDate(now);
  const datetime = isoDateTime(now);
  const normalizedKey = normalizeR2ObjectKey(config, key);

  const encodedKey = normalizedKey.split("/").map(sigV4Encode).join("/");
  const path = `/${config.bucketName}/${encodedKey}`;

  const credScope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${credScope}`,
    "X-Amz-Date": datetime,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host"
  };
  if (options.responseContentDisposition) {
    queryParams["response-content-disposition"] = options.responseContentDisposition;
  }
  const canonicalQuery = buildCanonicalQueryString(queryParams);

  const canonicalRequest = ["GET", path, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");

  const stringToSign = `AWS4-HMAC-SHA256\n${datetime}\n${credScope}\n${sha256Hex(canonicalRequest)}`;
  const sigKey = signingKey(config.secretAccessKey, date);
  const signature = hmacHex(sigKey, stringToSign);

  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function r2Host(config: R2Config) {
  if (config.endpoint) return new URL(config.endpoint).hostname;
  if (config.accountId) return `${config.accountId}.r2.cloudflarestorage.com`;
  throw new Error("R2 endpoint or account ID is required");
}

function normalizeR2ObjectKey(config: R2Config, key: string) {
  const normalized = key.replace(/^\/+/, "");
  const bucketPrefix = `${config.bucketName}/`;
  return normalized.startsWith(bucketPrefix) ? normalized.slice(bucketPrefix.length) : normalized;
}

type ParsedContent = { key: string; size: number; lastModified: string; etag?: string };

function parseContents(xml: string): ParsedContent[] {
  const results: ParsedContent[] = [];
  const blockRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let block: RegExpExecArray | null;

  while ((block = blockRe.exec(xml)) !== null) {
    const inner = block[1];
    const key = extractXml(inner, "Key");
    const size = extractXml(inner, "Size");
    const lastModified = extractXml(inner, "LastModified");
    if (key && size && lastModified) {
      const etag = extractXml(inner, "ETag")?.replace(/&quot;/g, "").replace(/"/g, "");
      results.push({ key, size: Number(size), lastModified, etag });
    }
  }

  return results;
}

function extractXml(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match?.[1];
}
