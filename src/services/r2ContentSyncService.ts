import type { PactSession } from "../auth/sessionService.js";
import type { AppConfig } from "../config/config.js";
import type { PactContent } from "../domain/types.js";
import { AppError } from "../errors/AppError.js";
import type { PactRepository } from "../repositories/pactRepository.js";
import { deckFromDocuments, isDeckFile, isInstructorGuideFile } from "./deckImportService.js";
import { challengeMechanicsFor, mergeChallengeReleases } from "./releaseImportService.js";
import { listR2Documents, type R2DocumentItem } from "./r2Service.js";

type R2Config = Parameters<typeof listR2Documents>[0];

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
    private readonly config: AppConfig
  ) {}

  async syncCourseContent(session: PactSession): Promise<R2ContentSyncResult> {
    if (session.role !== "admin" && session.role !== "instructor") {
      throw new AppError(403, "FORBIDDEN", "Instructor access is required");
    }

    const r2Config = this.r2Config();
    if (!r2Config) {
      throw new AppError(503, "R2_NOT_CONFIGURED", "R2 document storage is not configured");
    }

    const content = await this.repository.listContentForManagement(session);
    const result: R2ContentSyncResult = {
      scanned: content.length,
      synced: 0,
      skipped: 0,
      releaseFiles: 0,
      deckFiles: 0,
      content: [],
      skippedContent: []
    };

    for (const item of content) {
      if (item.type === "challenge" && item.mechanics?.kind === "challenge_path") {
        await this.syncChallengeReleases(session, r2Config, item, result);
        continue;
      }

      if (item.deck?.prefix) {
        await this.syncDeck(session, r2Config, item, result);
        continue;
      }

      result.skipped += 1;
      result.skippedContent.push({ contentId: item.id, reason: item.type === "workshop" ? "unsupported_content" : "no_r2_prefix" });
    }

    return result;
  }

  private async syncChallengeReleases(
    session: PactSession,
    r2Config: R2Config,
    content: PactContent,
    result: R2ContentSyncResult
  ) {
    const prefixes = challengeReleasePrefixes(content);
    if (!prefixes.length) {
      result.skipped += 1;
      result.skippedContent.push({ contentId: content.id, reason: "no_r2_prefix" });
      return;
    }

    const documents = (await Promise.all(prefixes.map((prefix) => listR2Documents(r2Config, prefix))))
      .flat()
      .filter((document) => document.size > 0);
    const uniqueDocuments = uniqueR2Documents(documents);
    if (!uniqueDocuments.length) {
      result.skipped += 1;
      result.skippedContent.push({ contentId: content.id, reason: "no_r2_files" });
      return;
    }

    const mechanics = mergeChallengeReleases(challengeMechanicsFor(content), uniqueDocuments);
    const updated = await this.repository.importContentReleaseMechanics({
      contentId: content.id,
      mechanics,
      session
    });
    result.synced += 1;
    result.releaseFiles += uniqueDocuments.length;
    result.content.push(updated);
  }

  private async syncDeck(
    session: PactSession,
    r2Config: R2Config,
    content: PactContent,
    result: R2ContentSyncResult
  ) {
    const prefix = content.deck?.prefix?.trim();
    if (!prefix) {
      result.skipped += 1;
      result.skippedContent.push({ contentId: content.id, reason: "no_r2_prefix" });
      return;
    }

    const documents = await listR2Documents(r2Config, prefix);
    const deckDocuments = documents.filter((document) => document.size > 0 && isDeckFile(document.key));
    const instructorGuideDocuments = documents.filter((document) => document.size > 0 && isInstructorGuideFile(document.key));
    if (!deckDocuments.length) {
      result.skipped += 1;
      result.skippedContent.push({ contentId: content.id, reason: "no_r2_files" });
      return;
    }

    const deck = deckFromDocuments(content, prefix, deckDocuments, instructorGuideDocuments);
    const updated = await this.repository.updateContentDeck({ contentId: content.id, deck, session });
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
