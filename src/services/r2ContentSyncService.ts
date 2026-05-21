import { performance } from "node:perf_hooks";
import type { PactSession } from "../auth/sessionService.js";
import type { AppConfig } from "../config/config.js";
import type { PactContent } from "../domain/types.js";
import { AppError } from "../errors/AppError.js";
import type { AppLogger } from "../logging/logger.js";
import type { PactRepository } from "../repositories/pactRepository.js";
import { deckFromDocuments, isDeckFile, isInstructorGuideFile } from "./deckImportService.js";
import { challengeMechanicsFor, mergeChallengeReleases } from "./releaseImportService.js";
import { listR2Documents, type R2DocumentItem } from "./r2Service.js";

type R2Config = Parameters<typeof listR2Documents>[0];
type R2DocumentLister = ((prefix: string) => Promise<R2DocumentItem[]>) & {
  stats: () => {
    uniquePrefixCount: number;
    r2ListDurationMs: number;
  };
};
type R2SyncLogger = Pick<AppLogger, "info" | "warn">;

const R2_SYNC_CONCURRENCY = 6;

export type R2ContentSyncResult = {
  scanned: number;
  synced: number;
  skipped: number;
  releaseFiles: number;
  deckFiles: number;
  content: PactContent[];
  skippedContent: Array<{
    contentId: string;
    reason: "no_r2_prefix" | "no_r2_files" | "unsupported_content";
  }>;
};

export class R2ContentSyncService {
  constructor(
    private readonly repository: PactRepository,
    private readonly config: AppConfig,
    private readonly logger?: R2SyncLogger
  ) {}

  async syncCourseContent(session: PactSession): Promise<R2ContentSyncResult> {
    const startedAt = performance.now();
    const timings = {
      mongoUpdateDurationMs: 0
    };

    if (session.role !== "admin" && session.role !== "instructor") {
      throw new AppError(403, "FORBIDDEN", "Instructor access is required");
    }

    const r2Config = this.r2Config();
    if (!r2Config) {
      throw new AppError(503, "R2_NOT_CONFIGURED", "R2 document storage is not configured");
    }

    const content = await this.repository.listContentForManagement(session);
    this.logger?.info({
      event: "r2_content_sync_started",
      courseId: session.courseId,
      cohortId: session.cohortId,
      scanned: content.length,
      concurrency: R2_SYNC_CONCURRENCY
    }, "R2 content sync started");

    const result: R2ContentSyncResult = {
      scanned: content.length,
      synced: 0,
      skipped: 0,
      releaseFiles: 0,
      deckFiles: 0,
      content: [],
      skippedContent: []
    };

    const listDocuments = cachedR2DocumentLister(r2Config);
    await mapConcurrent(content, R2_SYNC_CONCURRENCY, async (item) => {
      if (item.type === "challenge" && item.mechanics?.kind === "challenge_path") {
        await this.syncChallengeReleases(session, listDocuments, item, result, timings);
        return;
      }

      if (item.deck?.prefix) {
        await this.syncDeck(session, listDocuments, item, result, timings);
        return;
      }

      result.skipped += 1;
      result.skippedContent.push({ contentId: item.id, reason: item.type === "workshop" ? "unsupported_content" : "no_r2_prefix" });
    });

    const listStats = listDocuments.stats();
    this.logger?.info({
      event: "r2_content_sync_completed",
      courseId: session.courseId,
      cohortId: session.cohortId,
      scanned: result.scanned,
      synced: result.synced,
      skipped: result.skipped,
      releaseFiles: result.releaseFiles,
      deckFiles: result.deckFiles,
      uniquePrefixCount: listStats.uniquePrefixCount,
      r2ListDurationMs: Math.round(listStats.r2ListDurationMs),
      mongoUpdateDurationMs: Math.round(timings.mongoUpdateDurationMs),
      totalDurationMs: Math.round(performance.now() - startedAt)
    }, "R2 content sync completed");

    return result;
  }

  private async syncChallengeReleases(
    session: PactSession,
    listDocuments: R2DocumentLister,
    content: PactContent,
    result: R2ContentSyncResult,
    timings: { mongoUpdateDurationMs: number }
  ) {
    const prefixes = challengeReleasePrefixes(content);
    if (!prefixes.length) {
      result.skipped += 1;
      result.skippedContent.push({ contentId: content.id, reason: "no_r2_prefix" });
      return;
    }

    const documents = (await Promise.all(prefixes.map((prefix) => listDocuments(prefix))))
      .flat()
      .filter((document) => document.size > 0);
    const uniqueDocuments = uniqueR2Documents(documents);
    if (!uniqueDocuments.length) {
      result.skipped += 1;
      result.skippedContent.push({ contentId: content.id, reason: "no_r2_files" });
      return;
    }

    const mechanics = mergeChallengeReleases(challengeMechanicsFor(content), uniqueDocuments);
    const updateStartedAt = performance.now();
    const updated = await this.repository.importContentReleaseMechanics({
      contentId: content.id,
      mechanics,
      session
    });
    timings.mongoUpdateDurationMs += performance.now() - updateStartedAt;
    result.synced += 1;
    result.releaseFiles += uniqueDocuments.length;
    result.content.push(updated);
  }

  private async syncDeck(
    session: PactSession,
    listDocuments: R2DocumentLister,
    content: PactContent,
    result: R2ContentSyncResult,
    timings: { mongoUpdateDurationMs: number }
  ) {
    const prefix = content.deck?.prefix?.trim();
    if (!prefix) {
      result.skipped += 1;
      result.skippedContent.push({ contentId: content.id, reason: "no_r2_prefix" });
      return;
    }

    const documents = await listDocuments(prefix);
    const deckDocuments = documents.filter((document) => document.size > 0 && isDeckFile(document.key));
    const instructorGuideDocuments = documents.filter((document) => document.size > 0 && isInstructorGuideFile(document.key));
    if (!deckDocuments.length) {
      result.skipped += 1;
      result.skippedContent.push({ contentId: content.id, reason: "no_r2_files" });
      return;
    }

    const deck = deckFromDocuments(content, prefix, deckDocuments, instructorGuideDocuments);
    const updateStartedAt = performance.now();
    const updated = await this.repository.updateContentDeck({ contentId: content.id, deck, session });
    timings.mongoUpdateDurationMs += performance.now() - updateStartedAt;
    result.synced += 1;
    result.deckFiles += deck.files.length;
    result.content.push(updated);
  }

  private r2Config(): R2Config | undefined {
    const { r2AccountId, r2Endpoint, r2AccessKeyId, r2SecretAccessKey, r2BucketName } = this.config;
    if ((!r2AccountId && !r2Endpoint) || !r2AccessKeyId || !r2SecretAccessKey || !r2BucketName) return undefined;
    return {
      accountId: r2AccountId,
      endpoint: r2Endpoint,
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
      bucketName: r2BucketName
    };
  }
}

function challengeReleasePrefixes(content: PactContent) {
  if (content.mechanics?.kind !== "challenge_path") return [];
  const prefixes = new Set<string>();
  for (const release of content.mechanics.releases ?? []) {
    for (const file of release.files ?? []) {
      const prefix = releasePrefixFromKey(file.key);
      if (prefix) prefixes.add(prefix);
    }
  }
  return [...prefixes].sort();
}

function releasePrefixFromKey(key: string) {
  return key.match(/^(.*\/)release_R\d+\//i)?.[1];
}

function uniqueR2Documents(documents: R2DocumentItem[]) {
  const byKey = new Map<string, R2DocumentItem>();
  for (const document of documents) byKey.set(document.key, document);
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function cachedR2DocumentLister(r2Config: R2Config): R2DocumentLister {
  const cache = new Map<string, Promise<R2DocumentItem[]>>();
  let r2ListDurationMs = 0;

  const listDocuments = ((prefix: string) => {
    const cached = cache.get(prefix);
    if (cached) return cached;
    const listStartedAt = performance.now();
    const documents = listR2Documents(r2Config, prefix).finally(() => {
      r2ListDurationMs += performance.now() - listStartedAt;
    });
    cache.set(prefix, documents);
    return documents;
  }) as R2DocumentLister;

  listDocuments.stats = () => ({
    uniquePrefixCount: cache.size,
    r2ListDurationMs
  });

  return listDocuments;
}

async function mapConcurrent<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  }));
}
