import { describe, expect, it } from "vitest";
import { contentFromQuestionBank } from "../src/content/questionBankImport.js";

describe("question bank import", () => {
  it("maps a question bank file to a published PACT module", () => {
    const result = contentFromQuestionBank({
      fileName: "day1_lecture1_questions.json",
      rawJson: JSON.stringify(questionBank("q-1")),
      courseId: "pact",
      cohortId: "cohort-a"
    });

    expect(result.content).toMatchObject({
      id: "module-day1-lecture1",
      courseId: "pact",
      cohortId: "cohort-a",
      role: "all",
      type: "module",
      title: "Day 1 Lecture 1",
      maxScore: 5,
      day: "day_1",
      questionCount: 1,
      status: "published"
    });
    expect(result.content?.questions?.[0].id).toBe("q-1");
  });

  it("skips duplicate question IDs across imported files", () => {
    const seenQuestionIds = new Set<string>();

    contentFromQuestionBank({
      fileName: "day3_lecture1_questions.json",
      rawJson: JSON.stringify(questionBank("q-duplicate")),
      courseId: "pact",
      seenQuestionIds
    });

    const result = contentFromQuestionBank({
      fileName: "day3_lecture1_questions (1).json",
      rawJson: JSON.stringify(questionBank("q-duplicate")),
      courseId: "pact",
      seenQuestionIds
    });

    expect(result.content).toBeUndefined();
    expect(result.skippedQuestionIds).toEqual(["q-duplicate"]);
  });
});

function questionBank(questionId: string) {
  return {
    $comment: "Sample question bank",
    questions: [
      {
        id: questionId,
        version: 1,
        supersedes: null,
        type: "multiple_choice",
        day: "day_1",
        role: "both",
        topic: "topic",
        tags: ["tag"],
        stem: { en: "Question?" },
        payload: { kind: "multiple_choice" },
        feedback: { correct: { en: "Correct" } },
        scoring: { points: 5, difficulty: "basic", mustPass: false },
        status: "published",
        createdAt: "2026-05-05T14:00:00Z",
        updatedAt: "2026-05-05T14:00:00Z"
      }
    ]
  };
}
