import { basename } from "node:path";
import { z } from "zod";
import type { ContentType, PactContent, PactQuestion } from "../domain/types.js";

const localizedTextSchema = z.record(z.string().min(1));

const questionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  supersedes: z.string().nullable(),
  type: z.string().min(1),
  day: z.string().min(1),
  role: z.string().min(1),
  topic: z.string().min(1),
  tags: z.array(z.string()),
  stem: localizedTextSchema,
  payload: z.record(z.unknown()),
  feedback: z.record(z.unknown()),
  scoring: z.object({
    points: z.number().nonnegative(),
    difficulty: z.string().min(1),
    mustPass: z.boolean()
  }),
  status: z.enum(["draft", "published", "archived"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

const questionBankSchema = z.object({
  $comment: z.string().optional(),
  questions: z.array(questionSchema).min(1)
});

export type QuestionBankImportInput = {
  fileName: string;
  rawJson: string;
  courseId: string;
  cohortId?: string;
  seenQuestionIds?: Set<string>;
};

export type QuestionBankImportResult = {
  content?: Omit<PactContent, "createdAt" | "updatedAt">;
  skippedQuestionIds: string[];
};

export function contentFromQuestionBank(input: QuestionBankImportInput): QuestionBankImportResult {
  const parsed = questionBankSchema.parse(JSON.parse(input.rawJson));
  const seenQuestionIds = input.seenQuestionIds ?? new Set<string>();
  const skippedQuestionIds: string[] = [];
  const questions: PactQuestion[] = [];

  for (const question of parsed.questions) {
    if (seenQuestionIds.has(question.id)) {
      skippedQuestionIds.push(question.id);
      continue;
    }
    seenQuestionIds.add(question.id);
    questions.push(question);
  }

  if (!questions.length) {
    return { skippedQuestionIds };
  }

  const contentType = contentTypeFromFileName(input.fileName);
  const title = titleFromFileName(input.fileName);
  const days = [...new Set(questions.map((question) => question.day))];

  return {
    skippedQuestionIds,
    content: {
      id: stableContentId(input.fileName, contentType),
      courseId: input.courseId,
      cohortId: input.cohortId,
      role: "all",
      type: contentType,
      title,
      prompt: parsed.$comment ?? `${title} question bank`,
      maxScore: questions.reduce((total, question) => total + question.scoring.points, 0),
      day: days.length === 1 ? days[0] : "mixed",
      questionCount: questions.length,
      questions,
      status: questions.every((question) => question.status === "published") ? "published" : "draft"
    }
  };
}

function stableContentId(fileName: string, contentType: ContentType) {
  return `${contentType}-${normalizedBaseName(fileName).replace(/-questions$/, "")}`;
}

function titleFromFileName(fileName: string) {
  const base = normalizedBaseName(fileName).replace(/-questions$/, "");
  if (base === "pretest") return "Pre-test";
  if (base === "posttest") return "Post-test";
  return base
    .split("-")
    .map((part) => {
      if (/^day\d+$/.test(part)) return `Day ${part.replace("day", "")}`;
      if (/^[a-z]+\d+$/i.test(part)) return `${part.replace(/\d+$/, "")} ${part.match(/\d+$/)?.[0] ?? ""}`.trim().replace(/^\w/, (letter) => letter.toUpperCase());
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function contentTypeFromFileName(fileName: string): ContentType {
  const base = normalizedBaseName(fileName).replace(/-questions$/, "");
  return /^(pretest|posttest)$/.test(base) ? "assessment" : "module";
}

function normalizedBaseName(fileName: string) {
  return basename(fileName)
    .replace(/\.json$/i, "")
    .replace(/\s+\(\d+\)$/u, "")
    .replace(/_/g, "-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
