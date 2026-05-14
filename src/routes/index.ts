import { Router, type NextFunction, type Request, type Response } from "express";
import type { AppConfig } from "../config/config.js";
import { getMongoDb } from "../db/mongo.js";
import { currentSession, requirePactRole } from "../middleware/currentSession.js";
import { LmsAgsClient } from "../integrations/lmsAgsClient.js";
import { PactRepository } from "../repositories/pactRepository.js";
import { LtiLaunchService } from "../services/ltiLaunchService.js";
import { DeepLinkingService } from "../services/deepLinkingService.js";
import { PactService } from "../services/pactService.js";
import { ToolKeyService } from "../services/toolKeyService.js";
import { contentAssignmentUpdateSchema, contentCreateSchema, contentLmsLabelUpdateSchema, contentProgressUpdateSchema, contentStatusUpdateSchema, ltiDeepLinkSchema, ltiLaunchSchema, questionAttemptQuerySchema, questionAttemptSubmitSchema, scoreSubmitSchema, squadAssignmentSchema, squadCreateSchema } from "../validators/schemas.js";
import { AppError } from "../errors/AppError.js";
import type { ContentType } from "../domain/types.js";

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

  router.use(currentSession(config));

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

  router.post("/scores", async (req, res, next) => {
    try {
      res.status(201).json(await pactService(config).then((service) => service.submitScore(requireSession(req), scoreSubmitSchema.parse(req.body))));
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
      res.status(200).json({ cohorts: await repository.listAdminCohorts(requireSession(req)) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/audit-events", requirePactRole("admin"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json({ events: await repository.listAdminAuditEvents(requireSession(req)) });
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
      if (acceptsHtml(req)) {
        const target = new URL(config.pactWebBaseUrl);
        target.hash = `sessionToken=${encodeURIComponent(response.sessionToken)}`;
        res.redirect(303, target.toString());
        return;
      }
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  };
}

function parseLaunchContentType(value: string | undefined): ContentType {
  if (value === "module" || value === "challenge" || value === "game" || value === "assessment") {
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
  return new PactService(await pactRepository(config), new LmsAgsClient());
}

function requireSession(req: Express.Request) {
  if (!req.pactSession) throw new AppError(401, "AUTH_REQUIRED", "Authentication is required");
  return req.pactSession;
}
