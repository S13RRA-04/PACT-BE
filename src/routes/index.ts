import { Router } from "express";
import type { AppConfig } from "../config/config.js";
import { getMongoDb } from "../db/mongo.js";
import { currentSession, requirePactRole } from "../middleware/currentSession.js";
import { LmsAgsClient } from "../integrations/lmsAgsClient.js";
import { PactRepository } from "../repositories/pactRepository.js";
import { LtiLaunchService } from "../services/ltiLaunchService.js";
import { DeepLinkingService } from "../services/deepLinkingService.js";
import { PactService } from "../services/pactService.js";
import { ToolKeyService } from "../services/toolKeyService.js";
import { contentCreateSchema, ltiDeepLinkSchema, ltiLaunchSchema, scoreSubmitSchema, squadAssignmentSchema, squadCreateSchema } from "../validators/schemas.js";
import { AppError } from "../errors/AppError.js";

export function createApiRouter(config: AppConfig) {
  const router = Router();

  router.post("/lti/launch", async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      const response = await new LtiLaunchService(config, repository).handleLaunch(ltiLaunchSchema.parse(req.body).id_token);
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

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
      const html = await new DeepLinkingService(config, repository).createDeepLinkResponse(ltiDeepLinkSchema.parse(req.body).id_token);
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

  router.patch("/admin/users/:userId/squad", requirePactRole("admin"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(200).json(await repository.assignSquad(req.params.userId, squadAssignmentSchema.parse(req.body).squadId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/content", requirePactRole("admin", "instructor"), async (req, res, next) => {
    try {
      const repository = await pactRepository(config);
      res.status(201).json(await repository.upsertContent(contentCreateSchema.parse(req.body)));
    } catch (error) {
      next(error);
    }
  });

  return router;
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
