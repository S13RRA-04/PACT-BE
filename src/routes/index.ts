import { timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { AppConfig } from "../config/config.js";
import { getMongoDb } from "../db/mongo.js";
import { currentSession, expiredSessionCookie, requireCsrfForCookieSession, requirePactRole, sessionCookie } from "../middleware/currentSession.js";
import { LmsAgsClient } from "../integrations/lmsAgsClient.js";
import { LmsTokenClient } from "../integrations/lmsTokenClient.js";
import { PactRepository } from "../repositories/pactRepository.js";
import { LtiLaunchService } from "../services/ltiLaunchService.js";
import { DeepLinkingService } from "../services/deepLinkingService.js";
import { PactService } from "../services/pactService.js";
import { ToolKeyService } from "../services/toolKeyService.js";
import { agendaUploadSchema, agsBackfillSchema, agsPublishAttemptExportQuerySchema, agsPublishAttemptQuerySchema, agsPublishRetrySchema, auditEventQuerySchema, bugReportCreateSchema, capstoneImportSchema, contentAssignmentUpdateSchema, contentCreateSchema, contentLmsLabelUpdateSchema, contentLockUpdateSchema, contentMechanicsUpdateSchema, contentProgressUpdateSchema, contentStatusUpdateSchema, deckImportSchema, deckLockUpdateSchema, ltiDeepLinkSchema, ltiLaunchSchema, manualQuestionGradeSchema, notificationDiagnosticQuerySchema, questionAttemptQuerySchema, questionAttemptSubmitSchema, releaseImportSchema, schedulerAgsProcessDueSchema, scoreSubmitSchema, squadAssignmentSchema, squadCreateSchema } from "../validators/schemas.js";
import { AppError } from "../errors/AppError.js";
import type { ContentType } from "../domain/types.js";
import { listR2Documents, presignR2GetObject, putR2Object } from "../services/r2Service.js";
import { BugReportService } from "../services/bugReportService.js";
import { ReleaseImportService } from "../services/releaseImportService.js";
import { DeckImportService } from "../services/deckImportService.js";
import { LmsRosterSyncService } from "../services/lmsRosterSyncService.js";
import { CapstoneImportService } from "../services/capstoneImportService.js";

const agendaR2Prefix = "Agendas/";
const maxAgendaUploadBytes = 25 * 1024 * 1024;

export function createApiRouter(config: AppConfig) {
  const router = Router();

  router.post("/lti/launch", ltiLaunchHandler(config));

  router.get("/lti/jwks", async (_req, res, next) => {
    try {
      res.status(200).json(await new ToolKeyService(config).jwks());
    } catch (error) {
      next(error);
    }
  });

  router.post("/lti/deep-link", async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const service = new DeepLinkingService(config, repository);
      const idToken = ltiDeepLinkSchema.parse(req.body).id_token;
      if (acceptsJson(req)) {
        res.status(200).json(await service.createDeepLinkResponsePayload(idToken));
        return;
      }
      const html = await service.createDeepLinkResponse(idToken);
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.status(200).send(html);
    } catch (error) {
      next(error);
    }
  });

  router.post("/ops/ags-publish-attempts/process-due", async (req, res, next) => {
    try {
      requireSchedulerSecret(config, req);
      const input = schedulerAgsProcessDueSchema.parse(req.body ?? {});
      res.status(200).json(await pactService(config).then((service) => service.retryDueAgsPublishAttempts(input.limit)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/webhooks/linear", async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const result = await new BugReportService(repository, config).handleLinearWebhook({
        signature: req.header("linear-signature"),
        rawBody: req.rawBody,
        body: req.body
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.use(currentSession(config));
  router.use(requireCsrfForCookieSession);

  router.get("/content", async (req, res, next) => {
    try {
      res.status(200).json(await pactService(config).then((service) => service.getContent(requireSession(req))));
    } catch (error) {
      next(error);
    }
  });

  router.get("/content/progress", async (req, res, next) => {
    try {
      res.status(200).json({ progress: await pactService(config).then((service) => service.getContentProgress(requireSession(req))) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/content/squad-progress", async (req, res, next) => {
    try {
      res.status(200).json({ progress: await pactService(config).then((service) => service.getSquadContentProgress(requireSession(req))) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/content/:contentId/completion", async (req, res, next) => {
    try {
      res.status(200).json(await pactService(config).then((service) => service.getContentCompletionStatus(
        requireSession(req),
        req.params.contentId
      )));
    } catch (error) {
      next(error);
    }
  });

  router.get("/content/:contentId/squad-progress", async (req, res, next) => {
    try {
      res.status(200).json(await pactService(config).then((service) => service.getSquadContentProgressForContent(
        requireSession(req),
        req.params.contentId
      )));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/content/:contentId/progress", async (req, res, next) => {
    try {
      res.status(200).json(await pactService(config).then((service) => service.updateContentProgress(
        requireSession(req),
        req.params.contentId,
        contentProgressUpdateSchema.parse(req.body)
      )));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/content/:contentId/squad-progress", async (req, res, next) => {
    try {
      res.status(200).json(await pactService(config).then((service) => service.updateSquadContentProgress(
        requireSession(req),
        req.params.contentId,
        contentProgressUpdateSchema.parse(req.body)
      )));
    } catch (error) {
      next(error);
    }
  });

  router.post("/content/:contentId/squad-score", async (req, res, next) => {
    try {
      res.status(201).json(await pactService(config).then((service) => service.submitSquadScore(
        requireSession(req),
        req.params.contentId,
        scoreSubmitSchema.omit({ contentId: true, agsAccessToken: true }).parse(req.body)
      )));
    } catch (error) {
      next(error);
    }
  });

  router.post("/content/:contentId/questions/:questionId/attempts", async (req, res, next) => {
    try {
      res.status(201).json(await pactService(config).then((service) => service.submitQuestionAttempt(
        requireSession(req),
        req.params.contentId,
        req.params.questionId,
        questionAttemptSubmitSchema.parse(req.body)
      )));
    } catch (error) {
      next(error);
    }
  });

  router.get("/session", async (req, res, next) => {
    try {
      res.status(200).json(await pactService(config).then((service) => service.getSession(requireSession(req))));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/session", async (_req, res, next) => {
    try {
      res.setHeader("set-cookie", expiredSessionCookie(config));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post("/scores", async (req, res, next) => {
    try {
      res.status(201).json(await pactService(config).then((service) => service.submitScore(requireSession(req), scoreSubmitSchema.parse(req.body))));
    } catch (error) {
      next(error);
    }
  });

  router.post("/bug-reports", async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const report = await new BugReportService(repository, config).reportBug(
        requireSession(req),
        bugReportCreateSchema.parse(req.body)
      );
      res.status(201).json(report);
    } catch (error) {
      next(error);
    }
  });

  router.get("/dashboard/scoreboard", async (req, res, next) => {
    try {
      res.status(200).json({ entries: await pactService(config).then((service) => service.getScoreboard(requireSession(req))) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/agenda", async (req, res, next) => {
    try {
      const session = requireSession(req);
      const documents = await listR2Documents(
        r2ConfigOrThrow(config),
        agendaPrefixFor(session.courseId, session.cohortId)
      );
      res.status(200).json({ documents: documents.filter((document) => document.size > 0) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/squads", requirePactRole("admin"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(201).json(await repository.createSquad(squadCreateSchema.parse(req.body)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/cohorts", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      await new LmsRosterSyncService(config, repository).syncCourseRoster(requireSession(req).courseId);
      res.status(200).json({ cohorts: await repository.listAdminCohorts(requireSession(req)) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/audit-events", requirePactRole("admin"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const query = auditEventQuerySchema.parse(req.query);
      res.status(200).json({ events: await repository.listAdminAuditEvents({
        session: requireSession(req),
        ...query
      }) });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/users/:userId/squad", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const input = squadAssignmentSchema.parse(req.body);
      res.status(200).json(await repository.assignSquadForAdmin(req.params.userId, {
        squadId: input.squadId,
        squadNumber: input.squadNumber,
        session: requireSession(req)
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/content/:contentId/submissions", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json(await repository.listChallengeSubmissionsForReview({
        contentId: req.params.contentId,
        session: requireSession(req)
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/content", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(201).json(await repository.upsertContentForManagement(contentCreateSchema.parse(req.body), requireSession(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/content", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json(await repository.listContentForManagement(requireSession(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/diagnostics/session", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      res.status(200).json(await pactService(config).then((service) => service.getSessionDiagnostic(requireSession(req))));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/diagnostics/content-counts", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json({ counts: await repository.listContentCountsForDiagnostics(requireSession(req)) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/diagnostics/content-access", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json({ items: await repository.listContentAccessDiagnostics(requireSession(req)) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/diagnostics/ags-token-context", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      res.status(200).json(await pactService(config).then((service) => service.getAgsTokenContextDiagnostic(requireSession(req))));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/diagnostics/ags-publish-attempts", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const query = agsPublishAttemptQuerySchema.parse(req.query);
      res.status(200).json(await repository.listAgsPublishAttemptsForDiagnostics({
          session: requireSession(req),
          ...query
        }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/diagnostics/notifications", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const query = notificationDiagnosticQuerySchema.parse(req.query);
      res.status(200).json({ notifications: await repository.listNotificationsForDiagnostics(query) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/diagnostics/ags-publish-attempts/export.csv", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const query = agsPublishAttemptExportQuerySchema.parse(req.query);
      const attempts = await repository.listAgsPublishAttemptsForExport({
        session: requireSession(req),
        ...query
      });
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", "attachment; filename=\"ags-publish-attempts.csv\"");
      res.status(200).send(toAgsAttemptsCsv(attempts));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/diagnostics/ags-publish-attempts/process-due", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      res.status(200).json(await pactService(config).then((service) => service.processDueAgsPublishAttemptsForAdmin(requireSession(req))));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/diagnostics/ags-publish-attempts/backfill-completed", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const input = agsBackfillSchema.parse(req.body ?? {});
      res.status(200).json(await pactService(config).then((service) => service.backfillCompletedAgsSubmissionsForAdmin(requireSession(req), input)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/diagnostics/ags-publish-attempts/:attemptId/retry", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      res.status(200).json(await pactService(config).then((service) => service.retryAgsPublishAttempt(
        requireSession(req),
        req.params.attemptId,
        agsPublishRetrySchema.parse(req.body)
      )));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/content/lock-published", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json(await repository.lockPublishedContentForManagement(requireSession(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/analytics/cohort-progress", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const cohortId = typeof req.query.cohortId === "string" && req.query.cohortId.trim() ? req.query.cohortId.trim() : undefined;
      res.status(200).json(await pactService(config).then((service) => service.getCohortProgressAnalytics(requireSession(req), cohortId)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/analytics/question-attempts", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const query = questionAttemptQuerySchema.parse(req.query);
      res.status(200).json({
        attempts: await pactService(config).then((service) => service.getQuestionAttempts(requireSession(req), query))
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/analytics/question-attempts/:attemptId/grade", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      res.status(200).json(await pactService(config).then((service) => service.gradeManualQuestionAttempt(
        requireSession(req),
        req.params.attemptId,
        manualQuestionGradeSchema.parse(req.body)
      )));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/content/:contentId/status", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json(await repository.updateContentStatus({
        contentId: req.params.contentId,
        status: contentStatusUpdateSchema.parse(req.body).status,
        session: requireSession(req)
      }));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/content/:contentId/lock", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json(await repository.updateContentLock({
        contentId: req.params.contentId,
        locked: contentLockUpdateSchema.parse(req.body).locked,
        session: requireSession(req)
      }));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/content/:contentId/assignment", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json(await repository.updateContentAssignment({
        contentId: req.params.contentId,
        cohortId: contentAssignmentUpdateSchema.parse(req.body).cohortId,
        session: requireSession(req)
      }));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/content/:contentId/lms-label", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json(await repository.updateContentLmsLabel({
        contentId: req.params.contentId,
        lmsLabel: contentLmsLabelUpdateSchema.parse(req.body).lmsLabel,
        session: requireSession(req)
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/r2/documents", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const prefix = typeof req.query.prefix === "string" ? req.query.prefix : undefined;
      const documents = await listR2Documents(r2ConfigOrThrow(config), prefix);
      res.status(200).json({ documents });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/agenda", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const session = requireSession(req);
      const input = agendaUploadSchema.parse(req.body);
      const body = Buffer.from(input.bodyBase64, "base64");
      if (!body.length) {
        throw new AppError(400, "AGENDA_UPLOAD_EMPTY", "Agenda upload must include file content");
      }
      if (body.length > maxAgendaUploadBytes) {
        throw new AppError(413, "AGENDA_UPLOAD_TOO_LARGE", "Agenda upload exceeds the 25 MB limit");
      }

      const r2Config = r2ConfigOrThrow(config);
      const key = `${agendaPrefixFor(session.courseId, input.cohortId ?? session.cohortId)}${safeFileName(input.fileName)}`;
      const result = await putR2Object(r2Config, {
        key,
        body,
        contentType: input.contentType || "application/octet-stream"
      });
      res.status(201).json({
        document: {
          key: result.key,
          size: body.length,
          lastModified: new Date().toISOString(),
          etag: result.etag,
          downloadUrl: presignR2GetObject(r2Config, result.key, { expiresIn: 3600 })
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/content/:contentId/mechanics", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json(await repository.updateContentMechanics({
        contentId: req.params.contentId,
        mechanics: contentMechanicsUpdateSchema.parse(req.body).mechanics,
        session: requireSession(req)
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/content/:contentId/releases/import", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const input = releaseImportSchema.parse(req.body);
      res.status(200).json(await new ReleaseImportService(repository, config).importChallengeReleases(
        requireSession(req),
        req.params.contentId,
        input.prefix
      ));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/content/:contentId/decks/import", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const input = deckImportSchema.parse(req.body);
      res.status(200).json(await new DeckImportService(repository, config).importDecks(
        requireSession(req),
        req.params.contentId,
        input.prefix
      ));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/content/:contentId/deck-lock", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json(await repository.updateContentDeckLock({
        contentId: req.params.contentId,
        unlocked: deckLockUpdateSchema.parse(req.body).unlocked,
        session: requireSession(req)
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/capstones/import", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const input = capstoneImportSchema.parse(req.body);
      res.status(200).json(await new CapstoneImportService(repository).importCapstone(requireSession(req), input));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function ltiLaunchHandler(config: AppConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const repository = await pactRepository(config);
      const response = await new LtiLaunchService(config, repository).handleLaunch(
        ltiLaunchSchema.parse(req.body).id_token,
        parseLaunchContentType(req.params.contentType)
      );
      res.setHeader("set-cookie", sessionCookie(response.sessionToken, config));
      if (acceptsHtml(req)) {
        const target = new URL(config.pactWebBaseUrl);
        res.redirect(303, target.toString());
        return;
      }
      res.status(200).json({ user: response.user, ags: response.ags, resourceLink: response.resourceLink });
    } catch (error) {
      next(error);
    }
  };
}

function parseLaunchContentType(value: string | undefined): ContentType | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "module" || value === "challenge" || value === "workshop" || value === "game" || value === "assessment" || value === "capstone") {
    return value;
  }

  throw new AppError(400, "INVALID_CONTENT_TYPE", "LTI launch content type is not supported");
}

function acceptsHtml(req: { headers: { accept?: string | string[] } }) {
  const accept = Array.isArray(req.headers.accept) ? req.headers.accept.join(",") : req.headers.accept ?? "";
  return accept.includes("text/html") && !accept.includes("application/json");
}

function acceptsJson(req: { headers: { accept?: string | string[] } }) {
  const accept = Array.isArray(req.headers.accept) ? req.headers.accept.join(",") : req.headers.accept ?? "";
  return accept.includes("application/json");
}

async function pactRepository(config: AppConfig) {
  return new PactRepository(await getMongoDb(config), config);
}

async function pactService(config: AppConfig) {
  return new PactService(await pactRepository(config), new LmsAgsClient(), new LmsTokenClient(config), config);
}

function r2ConfigOrThrow(config: AppConfig) {
  const { r2AccountId, r2Endpoint, r2AccessKeyId, r2SecretAccessKey, r2BucketName } = config;
  if ((!r2AccountId && !r2Endpoint) || !r2AccessKeyId || !r2SecretAccessKey || !r2BucketName) {
    throw new AppError(503, "R2_NOT_CONFIGURED", "R2 document storage is not configured");
  }
  return {
    accountId: r2AccountId,
    endpoint: r2Endpoint,
    accessKeyId: r2AccessKeyId,
    secretAccessKey: r2SecretAccessKey,
    bucketName: r2BucketName
  };
}

function agendaPrefixFor(courseId: string, cohortId: string) {
  return `${agendaR2Prefix}${safePathSegment(courseId)}/${safePathSegment(cohortId)}/`;
}

function safePathSegment(value: string) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new AppError(400, "INVALID_AGENDA_PATH", "Agenda course or cohort path segment is invalid");
  }
  return normalized.slice(0, 120);
}

function safeFileName(value: string) {
  const baseName = value.trim().split(/[\\/]/).filter(Boolean).pop() ?? "";
  const normalized = baseName.replace(/[^a-zA-Z0-9 ._()-]+/g, "-").replace(/\s+/g, " ").trim();
  if (!normalized || normalized === "." || normalized === "..") {
    throw new AppError(400, "INVALID_AGENDA_FILENAME", "Agenda file name is invalid");
  }
  return normalized.slice(0, 180);
}

function requireSession(req: Express.Request) {
  if (!req.pactSession) throw new AppError(401, "AUTH_REQUIRED", "Authentication is required");
  return req.pactSession;
}

function requireSchedulerSecret(config: AppConfig, req: Request) {
  if (!config.agsProcessDueSchedulerSecret) {
    throw new AppError(404, "SCHEDULER_NOT_CONFIGURED", "Scheduler processing is not configured");
  }
  const authorization = req.header("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? req.header("x-pact-scheduler-secret") ?? "";
  if (!timingSafeStringEqual(token, config.agsProcessDueSchedulerSecret)) {
    throw new AppError(401, "SCHEDULER_UNAUTHORIZED", "Scheduler authentication failed");
  }
}

function timingSafeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function toAgsAttemptsCsv(attempts: Array<Record<string, unknown>>) {
  const headers = [
    "id",
    "courseId",
    "cohortId",
    "squadId",
    "userId",
    "contentId",
    "lineItemUrl",
    "score",
    "maxScore",
    "progressPercent",
    "status",
    "retryCount",
    "nextRetryAt",
    "errorCode",
    "errorMessage",
    "createdAt"
  ];
  return [
    headers.join(","),
    ...attempts.map((attempt) => headers.map((header) => csvCell(attempt[header])).join(","))
  ].join("\n");
}

function csvCell(value: unknown) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}
