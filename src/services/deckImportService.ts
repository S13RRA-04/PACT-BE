import type { AppConfig } from "../config/config.js";
import type { PactSession } from "../auth/sessionService.js";
import { AppError } from "../errors/AppError.js";
import type { PactRepository } from "../repositories/pactRepository.js";
import { listR2Documents, type R2DocumentItem } from "./r2Service.js";

type R2Config = Parameters<typeof listR2Documents>[0];

export class DeckImportService {
  constructor(
    private readonly repository: PactRepository,
    private readonly config: AppConfig
  ) {}

  async importDecks(session: PactSession, contentId: string, prefix: string) {
    const content = await this.repository.requireContent(contentId);
    if (content.courseId !== session.courseId) {
      throw new AppError(403, "CONTENT_FORBIDDEN", "Content is outside this course");
    }

    const r2Config = this.r2Config();
    if (!r2Config) {
      throw new AppError(503, "R2_NOT_CONFIGURED", "R2 document storage is not configured");
    }

    const documents = await listR2Documents(r2Config, prefix);
    const deckDocuments = documents.filter((document) => document.size > 0 && isDeckFile(document.key));
    const instructorGuideDocuments = documents.filter((document) => document.size > 0 && isInstructorGuideFile(document.key));
    if (!deckDocuments.length) {
      throw new AppError(404, "DECK_FILES_NOT_FOUND", "No slide deck files were found for that R2 prefix");
    }

    const deck = {
      unlocked: content.deck?.unlocked ?? false,
      prefix,
      importedAt: new Date().toISOString(),
      files: deckDocuments.sort((left, right) => left.key.localeCompare(right.key)).map(deckFileFromDocument),
      instructorGuideFiles: instructorGuideDocuments.sort((left, right) => left.key.localeCompare(right.key)).map(deckFileFromDocument)
    };
    const updated = await this.repository.updateContentDeck({ contentId, deck, session });
    return { content: updated, imported: deck.files.length };
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

function deckFileFromDocument(document: R2DocumentItem) {
  return {
    key: document.key,
    title: titleFromR2Key(document.key),
    description: document.key,
    contentType: contentTypeFromR2Key(document.key)
  };
}

function isDeckFile(key: string) {
  return [".ppt", ".pptx", ".pdf"].some((extension) => key.toLowerCase().endsWith(extension));
}

function isInstructorGuideFile(key: string) {
  const lower = key.toLowerCase();
  return /\.(docx?|pdf)$/i.test(lower) && (lower.includes("instructor") || lower.includes("guide") || lower.includes("lesson_plan") || lower.includes("lesson-plan"));
}

function titleFromR2Key(key: string) {
  const file = key.split("/").pop() ?? key;
  return file.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function contentTypeFromR2Key(key: string) {
  const extension = key.split(".").pop()?.toLowerCase();
  if (extension === "ppt") return "application/vnd.ms-powerpoint";
  if (extension === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (extension === "pdf") return "application/pdf";
  if (extension === "doc") return "application/msword";
  if (extension === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return undefined;
}
