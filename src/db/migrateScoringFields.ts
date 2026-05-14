import "dotenv/config";
import { pathToFileURL } from "node:url";
import type { Collection, Filter, WithId } from "mongodb";
import { loadConfig } from "../config/config.js";
import { closeMongoClient, collectionName, getMongoDb } from "./mongo.js";

export type ScoringMigrationOptions = {
  apply: boolean;
  courseId?: string;
};

export type ScoringMigrationSummary = {
  dryRun: boolean;
  scannedContent: number;
  changedContent: number;
  changedQuestions: number;
  missingPointQuestions: Array<{ contentId?: string; questionId?: string }>;
  appliedContent: number;
};

export type ContentDocument = {
  id?: string;
  courseId?: string;
  updatedAt?: string;
  questions?: Array<{
    id?: string;
    scoring?: Record<string, unknown>;
  }>;
};

export async function migrateScoringFields(collection: Collection<ContentDocument>, options: ScoringMigrationOptions): Promise<ScoringMigrationSummary> {
  const filter: Filter<ContentDocument> = {
    questions: { $exists: true, $type: "array" },
    ...(options.courseId ? { courseId: options.courseId } : {})
  };
  const cursor = collection.find(filter);
  const summary = {
    dryRun: !options.apply,
    scannedContent: 0,
    changedContent: 0,
    changedQuestions: 0,
    missingPointQuestions: [] as Array<{ contentId?: string; questionId?: string }>,
    appliedContent: 0
  };

  for await (const document of cursor as AsyncIterable<WithId<ContentDocument>>) {
    summary.scannedContent += 1;
    const questions = document.questions ?? [];
    let documentChanged = false;
    let changedQuestions = 0;
    const nextQuestions = questions.map((question) => {
      const scoring = question.scoring ?? {};
      if (typeof scoring.points !== "number") {
        summary.missingPointQuestions.push({ contentId: document.id, questionId: question.id });
      }
      const nextScoring = {
        mustPass: false,
        optional: false,
        gradingMode: "automatic",
        ...scoring
      };
      const changed = scoring.mustPass === undefined
        || scoring.optional === undefined
        || scoring.gradingMode === undefined;
      if (changed) {
        documentChanged = true;
        changedQuestions += 1;
      }
      return changed ? { ...question, scoring: nextScoring } : question;
    });

    if (!documentChanged) continue;

    summary.changedContent += 1;
    summary.changedQuestions += changedQuestions;
    if (options.apply) {
      await collection.updateOne({ _id: document._id }, { $set: { questions: nextQuestions, updatedAt: new Date().toISOString() } });
      summary.appliedContent += 1;
    }
  }

  return summary;
}

if (isCliEntryPoint()) {
  const options = parseArgs(process.argv.slice(2));
  try {
    const config = loadConfig(process.env);
    const db = await getMongoDb(config);
    const collection = db.collection<ContentDocument>(collectionName(config, "pactContent"));
    const summary = await migrateScoringFields(collection, options);
    console.log(JSON.stringify(summary, null, 2));
    if (!options.apply) {
      console.log("Dry run only. Re-run with --apply to write these scoring defaults.");
    }
  } finally {
    await closeMongoClient();
  }
}

function parseArgs(args: string[]): ScoringMigrationOptions {
  const options: ScoringMigrationOptions = { apply: false };
  for (const arg of args) {
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg.startsWith("--courseId=")) {
      const courseId = arg.slice("--courseId=".length).trim();
      if (courseId) options.courseId = courseId;
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

function isCliEntryPoint() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
