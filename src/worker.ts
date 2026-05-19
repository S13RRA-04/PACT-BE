type WorkerEnv = {
  PACT_API_ORIGIN: string;
  CORS_ORIGINS?: string;
};

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), env, request);
    }

    const origin = env.PACT_API_ORIGIN?.replace(/\/$/, "");
    if (!origin || origin.includes("example.com")) {
      return withCors(
        Response.json(
          { error: { code: "PACT_ORIGIN_NOT_CONFIGURED", message: "PACT API origin is not configured" } },
          { status: 503 }
        ),
        env,
        request
      );
    }

    const url = new URL(request.url);
    const originUrl = new URL(origin);
    if (originUrl.host === url.host) {
      return withCors(
        Response.json(
          { error: { code: "PACT_ORIGIN_LOOP", message: "PACT API origin cannot match the Worker host" } },
          { status: 508 }
        ),
        env,
        request
      );
    }

    const upstreamUrl = new URL(`${origin}${url.pathname}${url.search}`);
    const upstreamRequest = new Request(upstreamUrl, request);
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamRequest);
    } catch (error) {
      return withCors(
        Response.json(
          { error: { code: "PACT_UPSTREAM_ERROR", message: "Unable to reach PACT API origin" } },
          { status: 502 }
        ),
        env,
        request
      );
    }
    return withCors(upstreamResponse, env, request);
  }
};

function withCors(response: Response, env: WorkerEnv, request: Request) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin");
  const allowedOrigins = String(env.CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (origin && allowedOrigins.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
  }

  headers.set("vary", "Origin");
  headers.set("access-control-allow-methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type,x-csrf-token,x-request-id");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
