import type { AppConfig } from "../config/config.js";
import type { PactSession } from "../auth/sessionService.js";
import type { ChallengeMechanics, PactContent } from "../domain/types.js";
import { AppError } from "../errors/AppError.js";
import type { PactRepository } from "../repositories/pactRepository.js";
import { listR2Documents, type R2DocumentItem } from "./r2Service.js";

type R2Config = Parameters<typeof listR2Documents>[0];

export class ReleaseImportService {
  constructor(
    private readonly repository: PactRepository,
    private readonly config: AppConfig
  ) {}

  async importChallengeReleases(session: PactSession, contentId: string, prefix: string) {
    const content = await this.repository.requireContent(contentId);
    if (content.courseId !== session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is outside this course");
    }
    if (content.type !== "challenge") {
      throw new AppError(400, "INVALID_RELEASE_CONTENT", "Release imports are only supported for challenge content");
    }

    const r2Config = this.r2Config();
    if (!r2Config) {
      throw new AppError(503, "R2_NOT_CONFIGURED", "R2 document storage is not configured");
    }

    const documents = await listR2Documents(r2Config, prefix);
    const releaseDocuments = documents.filter((document) => document.size > 0 && releaseIdFromKey(document.key));
    if (!releaseDocuments.length) {
      throw new AppError(404, "RELEASE_FILES_NOT_FOUND", "No scenario release files were found for that R2 prefix");
    }

    const mechanics = mergeChallengeReleases(challengeMechanicsFor(content), releaseDocuments);
    const updated = await this.repository.importContentReleaseMechanics({
      contentId,
      mechanics,
      session
    });

    return {
      content: updated,
      imported: releaseDocuments.length,
      releases: mechanics.releases?.length ?? 0
    };
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

function challengeMechanicsFor(content: PactContent): ChallengeMechanics {
  if (content.mechanics?.kind === "challenge_path") return content.mechanics;
  return {
    kind: "challenge_path",
    title: content.title,
    prompt: content.prompt,
    resultLabel: "Case progress",
    paths: [{ id: "develop", label: "Develop case", detail: "Review released evidence and continue case development.", score: 100 }]
  };
}

function mergeChallengeReleases(mechanics: ChallengeMechanics, documents: R2DocumentItem[]): ChallengeMechanics {
  const existing = new Map((mechanics.releases ?? []).map((release) => [release.id, release]));
  const grouped = new Map<string, R2DocumentItem[]>();
  for (const document of documents) {
    const releaseId = releaseIdFromKey(document.key);
    if (!releaseId) continue;
    grouped.set(releaseId, [...(grouped.get(releaseId) ?? []), document]);
  }

  const releases = [...grouped.entries()]
    .sort(([left], [right]) => releaseNumber(left) - releaseNumber(right))
    .map(([releaseId, releaseDocuments]) => {
      const current = existing.get(releaseId);
      return {
        id: releaseId,
        title: current?.title ?? releaseTitle(releaseId),
        summary: current?.summary ?? `Student case files from ${releaseId.replace("_", " ")}.`,
        releaseLabel: current?.releaseLabel ?? releaseId.replace("release_", "").toUpperCase(),
        unlocked: current?.unlocked ?? false,
        files: releaseDocuments
          .sort((left, right) => left.key.localeCompare(right.key))
          .map((document) => ({
            key: document.key,
            title: titleFromR2Key(document.key),
            description: document.key,
            contentType: contentTypeFromR2Key(document.key)
          })),
        questionIds: current?.questionIds
      };
    });

  return { ...mechanics, releases };
}

function releaseIdFromKey(key: string) {
  return key.match(/\/(release_R\d+)\//i)?.[1];
}

function releaseNumber(releaseId: string) {
  return Number(releaseId.match(/R(\d+)/i)?.[1] ?? 0);
}

function releaseTitle(releaseId: string) {
  return `Release ${releaseId.match(/R\d+/i)?.[0]?.toUpperCase() ?? releaseId}`;
}

function titleFromR2Key(key: string) {
  const file = key.split("/").pop() ?? key;
  return file.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function contentTypeFromR2Key(key: string) {
  const extension = key.split(".").pop()?.toLowerCase();
  if (extension === "txt") return "text/plain";
  if (extension === "md") return "text/markdown";
  if (extension === "csv") return "text/csv";
  if (extension === "html") return "text/html";
  if (extension === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === "eml") return "message/rfc822";
  return undefined;
}
