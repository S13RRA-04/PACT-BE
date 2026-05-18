import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/config.js";
import type { PactSession } from "../auth/sessionService.js";
import type { PactBugReport, PactBugReportSeverity } from "../domain/types.js";
import { AppError } from "../errors/AppError.js";
import { LinearClient } from "../integrations/linearClient.js";
import type { PactRepository } from "../repositories/pactRepository.js";

type BugReportInput = {
  title: string;
  description: string;
  severity: PactBugReportSeverity;
  pageUrl?: string;
  userAgent?: string;
};

type LinearWebhookPayload = {
  type?: unknown;
  action?: unknown;
  url?: unknown;
  webhookTimestamp?: unknown;
  data?: {
    id?: unknown;
    identifier?: unknown;
    url?: unknown;
    state?: {
      name?: unknown;
      type?: unknown;
    };
  };
};

export class BugReportService {
  constructor(
    private readonly repository: PactRepository,
    private readonly config: AppConfig,
    private readonly linearClient = createLinearClient(config)
  ) {}

  async reportBug(session: PactSession, input: BugReportInput) {
    const report = await this.repository.createBugReport({
      title: input.title,
      description: input.description,
      severity: input.severity,
      pageUrl: input.pageUrl,
      userAgent: input.userAgent,
      courseId: session.courseId,
      cohortId: session.cohortId,
      squadId: session.squadId,
      reporterUserId: session.userId,
      reporterRole: session.role,
      syncStatus: this.config.linearBugSyncEnabled ? "pending" : "disabled"
    });

    if (!this.config.linearBugSyncEnabled) {
      return report;
    }
    if (!this.linearClient) {
      throw new AppError(503, "LINEAR_NOT_CONFIGURED", "Linear bug sync is not configured");
    }

    try {
      const issue = await this.linearClient.createBugIssue({
        title: `[PACT Bug] ${input.title}`,
        description: linearDescription(report),
        severity: input.severity
      });
      return this.repository.updateBugReportLinearSync(report.id, {
        linearIssueId: issue.id,
        linearIssueIdentifier: issue.identifier,
        linearIssueUrl: issue.url,
        linearIssueState: issue.state,
        syncStatus: "synced"
      });
    } catch (error) {
      const syncError = error instanceof AppError ? error.code : "LINEAR_SYNC_FAILED";
      await this.repository.updateBugReportLinearSync(report.id, {
        syncStatus: "failed",
        syncError
      });
      throw error;
    }
  }

  async handleLinearWebhook(input: { signature?: string; rawBody?: Buffer; body: LinearWebhookPayload }) {
    if (!this.config.linearWebhookSecret) {
      throw new AppError(404, "LINEAR_WEBHOOK_NOT_CONFIGURED", "Linear webhook sync is not configured");
    }
    if (!verifyLinearSignature(this.config.linearWebhookSecret, input.signature, input.rawBody)) {
      throw new AppError(401, "LINEAR_WEBHOOK_UNAUTHORIZED", "Linear webhook signature is invalid");
    }
    if (typeof input.body.webhookTimestamp !== "number" || Math.abs(Date.now() - input.body.webhookTimestamp) > 60_000) {
      throw new AppError(401, "LINEAR_WEBHOOK_STALE", "Linear webhook timestamp is outside the allowed window");
    }
    if (input.body.type !== "Issue" || !input.body.data || typeof input.body.data.id !== "string") {
      return { matched: 0, modified: 0 };
    }

    return this.repository.syncBugReportFromLinearIssue({
      linearIssueId: input.body.data.id,
      linearIssueIdentifier: typeof input.body.data.identifier === "string" ? input.body.data.identifier : undefined,
      linearIssueUrl: typeof input.body.data.url === "string" ? input.body.data.url : typeof input.body.url === "string" ? input.body.url : undefined,
      linearIssueState: linearStateName(input.body.data.state)
    });
  }
}

function createLinearClient(config: AppConfig) {
  if (!config.linearApiKey || !config.linearTeamKey) return undefined;
  return new LinearClient(config.linearApiKey, config.linearTeamKey, config.linearProjectName);
}

function linearDescription(report: PactBugReport) {
  return [
    report.description,
    "",
    "----",
    `Severity: ${report.severity}`,
    `Reporter: ${report.reporterUserId} (${report.reporterRole})`,
    `Course: ${report.courseId}`,
    `Cohort: ${report.cohortId}`,
    report.squadId ? `Squad: ${report.squadId}` : undefined,
    report.pageUrl ? `Page: ${report.pageUrl}` : undefined,
    report.userAgent ? `User agent: ${report.userAgent}` : undefined,
    `PACT bug report ID: ${report.id}`
  ].filter(Boolean).join("\n");
}

function linearStateName(state: { name?: unknown; type?: unknown } | undefined) {
  if (!state || typeof state !== "object") return undefined;
  const name = "name" in state && typeof state.name === "string" ? state.name : undefined;
  const type = "type" in state && typeof state.type === "string" ? state.type : undefined;
  return name ?? type;
}

function verifyLinearSignature(secret: string, headerSignature: string | undefined, rawBody: Buffer | undefined) {
  if (!headerSignature || !rawBody) return false;
  const header = Buffer.from(headerSignature, "hex");
  const computed = createHmac("sha256", secret).update(rawBody).digest();
  return header.length === computed.length && timingSafeEqual(header, computed);
}
