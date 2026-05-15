import { describe, expect, it } from "vitest";
import type { PactQuestion } from "../src/domain/types.js";
import { scoreQuestion } from "../src/services/pactService.js";

describe("PACT question scoring", () => {
  it("requires all drag matches when partial credit is disabled", () => {
    const question: PactQuestion = {
      id: "match-all",
      version: 1,
      supersedes: null,
      type: "drag_match",
      day: "day_1",
      role: "both",
      topic: "topic",
      tags: ["post_test"],
      stem: { en: "Match all." },
      payload: {
        kind: "drag_match",
        matches: [
          { sourceId: "source-a", targetId: "target-a" },
          { sourceId: "source-b", targetId: "target-b" }
        ],
        partialCredit: false
      },
      feedback: {},
      scoring: { points: 4, difficulty: "core", mustPass: true },
      status: "published",
      createdAt: "2026-05-05T14:00:00Z",
      updatedAt: "2026-05-05T14:00:00Z"
    };

    expect(scoreQuestion(question, { "source-a": "target-a", "source-b": "target-a" })).toBe(0);
    expect(scoreQuestion(question, { "source-a": "target-a", "source-b": "target-b" })).toBe(4);
  });
});
