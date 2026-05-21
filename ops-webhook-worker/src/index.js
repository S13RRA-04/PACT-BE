export default {
  async scheduled(_event, env, ctx) {
    const jobs = [processDueAgsAttempts(env, { source: "scheduled" })];
    if (env.AGS_BACKFILL_COURSE_ID) {
      jobs.push(backfillCompletedAgsSubmissions(env, { source: "scheduled" }));
    }
    ctx.waitUntil(Promise.all(jobs));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "cetu-ops-webhook" });
    }

    if (!env.OPS_WEBHOOK_BEARER_TOKEN) {
      return Response.json({ error: "receiver_not_configured" }, { status: 503 });
    }

    const authorization = request.headers.get("authorization") ?? "";
    if (authorization !== `Bearer ${env.OPS_WEBHOOK_BEARER_TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    if (request.method === "GET" && url.pathname === "/alerts") {
      return listAlerts(env, url);
    }

    if (request.method === "POST" && url.pathname === "/pact-ags-process-due") {
      const limit = clampLimit(url.searchParams.get("limit"), 500);
      const result = await processDueAgsAttempts(env, { source: "manual", limit });
      return Response.json(result, { status: result.ok ? 200 : result.status });
    }

    if (request.method === "POST" && url.pathname === "/pact-ags-backfill-completed") {
      const limit = clampLimit(url.searchParams.get("limit"), 100);
      const courseId = url.searchParams.get("courseId") || env.AGS_BACKFILL_COURSE_ID;
      const cohortId = url.searchParams.get("cohortId") || env.AGS_BACKFILL_COHORT_ID || undefined;
      const result = await backfillCompletedAgsSubmissions(env, { source: "manual", courseId, cohortId, limit });
      return Response.json(result, { status: result.ok ? 200 : result.status });
    }

    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    let payload = undefined;
    try {
      payload = await request.json();
    } catch {
      payload = { invalidJson: true };
    }

    const alert = {
      id: crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
      path: url.pathname,
      event: typeof payload?.event === "string" ? payload.event : undefined,
      payload
    };

    await storeAlert(env, alert);
    console.log(JSON.stringify(alert));

    if (url.pathname === "/ags-retry-exhausted-fail") {
      return Response.json({ error: "forced_failure" }, { status: 500 });
    }

    if (url.pathname === "/ags-retry-exhausted") {
      return new Response(null, { status: 204 });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
};

async function processDueAgsAttempts(env, input) {
  if (!env.PACT_API_BASE_URL || !env.AGS_PROCESS_DUE_SCHEDULER_SECRET) {
    return { ok: false, status: 503, error: "pact_scheduler_not_configured" };
  }

  const baseUrl = env.PACT_API_BASE_URL.replace(/\/$/, "");
  const limit = input.limit ?? clampLimit(env.AGS_PROCESS_DUE_LIMIT, 500);
  const response = await fetch(`${baseUrl}/api/v1/ops/ags-publish-attempts/process-due`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.AGS_PROCESS_DUE_SCHEDULER_SECRET}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ limit })
  });

  let payload = undefined;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  const data = payload?.data ?? payload;
  const result = {
    ok: response.ok,
    status: response.status,
    source: input.source,
    scanned: data?.scanned,
    retried: data?.retried,
    failed: data?.failed,
    exhausted: data?.exhausted
  };

  console.log(JSON.stringify({ event: "pact.ags_process_due", ...result }));
  return result;
}

async function backfillCompletedAgsSubmissions(env, input) {
  if (!env.PACT_API_BASE_URL || !env.AGS_PROCESS_DUE_SCHEDULER_SECRET) {
    return { ok: false, status: 503, error: "pact_scheduler_not_configured" };
  }

  const courseId = input.courseId || env.AGS_BACKFILL_COURSE_ID;
  if (!courseId) {
    return { ok: false, status: 503, error: "ags_backfill_course_not_configured" };
  }

  const baseUrl = env.PACT_API_BASE_URL.replace(/\/$/, "");
  const limit = input.limit ?? clampLimit(env.AGS_BACKFILL_LIMIT, 100);
  const body = {
    courseId,
    cohortId: input.cohortId || env.AGS_BACKFILL_COHORT_ID || undefined,
    limit
  };
  const response = await fetch(`${baseUrl}/api/v1/ops/ags-publish-attempts/backfill-completed`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.AGS_PROCESS_DUE_SCHEDULER_SECRET}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  let payload = undefined;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  const data = payload?.data ?? payload;
  const result = {
    ok: response.ok,
    status: response.status,
    source: input.source,
    courseId,
    cohortId: body.cohortId,
    scanned: data?.scanned,
    published: data?.published,
    queued: data?.queued,
    skipped: data?.skipped,
    failed: data?.failed,
    remainingCandidates: data?.remainingCandidates
  };

  console.log(JSON.stringify({ event: "pact.ags_backfill_completed", ...result }));
  return result;
}

async function storeAlert(env, alert) {
  if (!env.ALERTS_KV) {
    throw new Error("ALERTS_KV binding is not configured");
  }

  const key = `alert:${alert.receivedAt}:${alert.id}`;
  await env.ALERTS_KV.put(key, JSON.stringify(alert), {
    expirationTtl: 60 * 60 * 24 * 90
  });
}

async function listAlerts(env, url) {
  if (!env.ALERTS_KV) {
    return Response.json({ error: "alerts_store_not_configured" }, { status: 503 });
  }

  const limit = clampLimit(url.searchParams.get("limit"));
  const cursor = url.searchParams.get("cursor") || undefined;
  const list = await env.ALERTS_KV.list({ prefix: "alert:", limit, cursor });
  const alerts = await Promise.all(list.keys.map(async (key) => env.ALERTS_KV.get(key.name, "json")));

  return Response.json({
    alerts: alerts.filter(Boolean).reverse(),
    cursor: list.list_complete ? undefined : list.cursor
  });
}

function clampLimit(value, max = 100) {
  const parsed = Number(value ?? 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}
