import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config/config.js";
import { closeMongoClient, ensureMongoCollections, getMongoDb } from "../db/mongo.js";
import { collectionName } from "../db/mongo.js";
import { contentFromQuestionBank } from "./questionBankImport.js";

type ImportArgs = {
  courseId: string;
  cohortId?: string;
  files: string[];
};

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(process.env);
const db = await getMongoDb(config);

try {
  await ensureMongoCollections(config);
  const seenQuestionIds = new Set<string>();
  let importedModules = 0;
  let importedQuestions = 0;
  let skippedQuestions = 0;

  for (const file of args.files) {
    const filePath = resolve(file);
    const result = contentFromQuestionBank({
      fileName: filePath,
      rawJson: await readFile(filePath, "utf8"),
      courseId: args.courseId,
      cohortId: args.cohortId,
      seenQuestionIds
    });

    skippedQuestions += result.skippedQuestionIds.length;

    if (!result.content) {
      console.log(`Skipped ${filePath}; all questions were duplicates.`);
      continue;
    }

    await db.collection(collectionName(config, "pactContent")).updateOne(
      { id: result.content.id },
      {
        $set: {
          ...result.content,
          updatedAt: new Date().toISOString()
        },
        $setOnInsert: {
          createdAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );

    importedModules += 1;
    importedQuestions += result.content.questionCount ?? 0;
    console.log(`Imported ${result.content.title}: ${result.content.questionCount} questions.`);
  }

  console.log(`PACT module import complete: ${importedModules} modules, ${importedQuestions} questions, ${skippedQuestions} duplicate questions skipped.`);
} finally {
  await closeMongoClient();
}

function parseArgs(argv: string[]): ImportArgs {
  const files: string[] = [];
  let courseId = process.env.PACT_MODULE_COURSE_ID ?? "pact";
  let cohortId = process.env.PACT_MODULE_COHORT_ID;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--course-id") {
      courseId = requiredValue(argv, index);
      index += 1;
      continue;
    }
    if (value === "--cohort-id") {
      cohortId = requiredValue(argv, index);
      index += 1;
      continue;
    }
    files.push(value);
  }

  if (!files.length) {
    throw new Error("Usage: npm run modules:import -- --course-id pact [--cohort-id cohort-a] <question-bank.json> [...]");
  }

  return { courseId, cohortId, files };
}

function requiredValue(argv: string[], index: number) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${argv[index]}`);
  }
  return value;
}
