import "dotenv/config";
import { loadConfig } from "../config/config.js";
import { closeMongoClient, collectionName, ensureMongoCollections, getMongoDb } from "../db/mongo.js";
import type { PactContent, SquadNumber } from "../domain/types.js";

type SeedArgs = {
  courseId: string;
  cohortId: string | null;
  lock: boolean;
};

type WorkshopSeed = {
  id: string;
  squadNumber: SquadNumber;
  title: string;
  prompt: string;
  questionCount: number;
};

const day1WorkshopSeeds: WorkshopSeed[] = [
  {
    id: "day1-pm-squad-1-anyproxy",
    squadNumber: "1",
    title: "Anyproxy Botnet",
    prompt: "Review the Anyproxy/5socks router botnet indictment and prepare squad answers on purpose, infrastructure, roles, charges, and persistence.",
    questionCount: 10
  },
  {
    id: "day1-pm-squad-2-qakbot",
    squadNumber: "2",
    title: "Qakbot Botnet & Ransomware",
    prompt: "Review the Qakbot indictment and prepare squad answers on botnet operation, ransomware partnerships, post-takedown behavior, and financial evidence.",
    questionCount: 10
  },
  {
    id: "day1-pm-squad-3-irgc",
    squadNumber: "3",
    title: "IRGC Hack-and-Leak",
    prompt: "Review the IRGC hack-and-leak indictment and prepare squad answers on spearphishing, persona accounts, material support, MFA bypass, and election interference.",
    questionCount: 10
  },
  {
    id: "day1-pm-squad-4-hafnium",
    squadNumber: "4",
    title: "HAFNIUM / PRC State-Sponsored Hacking",
    prompt: "Review the Xu Zewei/Zhang Yu indictment and prepare squad answers on SSSB direction, Exchange exploitation, web shells, COVID research targeting, and identity theft.",
    questionCount: 10
  }
];

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(process.env);
const db = await getMongoDb(config);

try {
  await ensureMongoCollections(config);
  const now = new Date().toISOString();
  let upserted = 0;
  let modified = 0;

  for (const workshop of day1WorkshopSeeds) {
    const content = workshopContent(workshop, args, now);
    const { createdAt: _createdAt, ...contentUpdate } = content;
    const result = await db.collection<PactContent>(collectionName(config, "pactContent")).updateOne(
      { id: content.id },
      {
        $set: {
          ...contentUpdate,
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );
    upserted += result.upsertedCount;
    modified += result.modifiedCount;
  }

  console.log(`Seeded Day 1 workshop markers for course ${args.courseId}, cohort ${args.cohortId ?? "all cohorts"}: ${upserted} inserted, ${modified} updated.`);
} finally {
  await closeMongoClient();
}

function workshopContent(workshop: WorkshopSeed, args: SeedArgs, now: string): PactContent {
  return {
    id: `workshop:${workshop.id}`,
    courseId: args.courseId,
    cohortId: args.cohortId,
    role: "learner",
    type: "workshop",
    title: workshop.title,
    prompt: workshop.prompt,
    maxScore: workshop.questionCount,
    questionCount: workshop.questionCount,
    status: "published",
    locked: args.lock,
    createdAt: now,
    updatedAt: now
  };
}

function parseArgs(argv: string[]): SeedArgs {
  let courseId = process.env.PACT_WORKSHOP_COURSE_ID ?? "pact";
  let cohortId: string | null = process.env.PACT_WORKSHOP_COHORT_ID ?? null;
  let lock = parseBoolean(process.env.PACT_WORKSHOP_LOCKED, false);

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--course-id") {
      courseId = requiredValue(argv, index);
      index += 1;
      continue;
    }
    if (value === "--cohort-id") {
      const next = requiredValue(argv, index);
      cohortId = next === "null" || next === "all" ? null : next;
      index += 1;
      continue;
    }
    if (value === "--global") {
      cohortId = null;
      continue;
    }
    if (value === "--locked") {
      lock = true;
      continue;
    }
    if (value === "--unlocked") {
      lock = false;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!courseId.trim()) {
    throw new Error("Workshop seed courseId is required.");
  }

  return { courseId: courseId.trim(), cohortId: cohortId?.trim() || null, lock };
}

function requiredValue(argv: string[], index: number) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${argv[index]}`);
  }
  return value;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}
