import type { PactSession } from "../auth/sessionService.js";
import type { CapstoneMechanics, PactContent } from "../domain/types.js";
import type { PactRepository } from "../repositories/pactRepository.js";
import type { capstoneImportSchema } from "../validators/schemas.js";
import type { z } from "zod";

type CapstoneImportInput = z.infer<typeof capstoneImportSchema>;

export class CapstoneImportService {
  constructor(private readonly repository: PactRepository) {}

  async importCapstone(session: PactSession, input: CapstoneImportInput) {
    const { capstone, cohortId } = input;

    const mechanics: CapstoneMechanics = {
      kind: "daily_progression_capstone",
      title: capstone.title.en,
      prompt: capstone.studentInstructions.en,
      day: capstone.day,
      session: capstone.session,
      version: capstone.version,
      releaseDependencies: capstone.releaseDependencies,
      estimatedMinutes: capstone.estimatedMinutes,
      scoringMode: capstone.scoringMode,
      progressionRole: capstone.progressionRole,
      questions: capstone.questions,
      rubric: capstone.rubric
    };

    const content: Omit<PactContent, "id" | "createdAt" | "updatedAt"> & { id?: string } = {
      id: capstoneContentId(capstone._id),
      courseId: session.courseId,
      cohortId: cohortId ?? null,
      role: "all",
      type: "capstone",
      title: capstone.title.en,
      prompt: capstone.studentInstructions.en,
      day: String(capstone.day),
      maxScore: capstone.rubric.maxPoints,
      mechanics,
      status: "published",
      locked: true
    };

    const upserted = await this.repository.upsertContentForManagement(content, session);

    return {
      content: upserted,
      day: capstone.day,
      questionCount: capstone.questions.length
    };
  }
}

function capstoneContentId(rawId: string) {
  return rawId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
