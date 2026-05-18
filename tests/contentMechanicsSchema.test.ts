import { describe, expect, it } from "vitest";
import { contentCreateSchema } from "../src/validators/schemas.js";

const baseContent = {
  courseId: "pact",
  role: "learner" as const,
  title: "Packet Pursuit",
  prompt: "Complete the operation.",
  maxScore: 100
};

describe("content mechanics schema", () => {
  it("locks newly created content by default", () => {
    const parsed = contentCreateSchema.parse({
      ...baseContent,
      type: "module"
    });

    expect(parsed.locked).toBe(true);
  });

  it("accepts workshop content without mechanics", () => {
    const parsed = contentCreateSchema.parse({
      ...baseContent,
      type: "workshop"
    });

    expect(parsed.type).toBe("workshop");
    expect(parsed.mechanics).toBeUndefined();
  });

  it("accepts backend-driven game mechanics", () => {
    const parsed = contentCreateSchema.parse({
      ...baseContent,
      type: "game",
      mechanics: {
        kind: "packet_capture",
        title: "Capture the packet trail",
        prompt: "Select telemetry nodes to build the evidence chain.",
        initiallyCaptured: ["dns"],
        nodes: [
          { id: "dns", label: "DNS", points: 20 },
          { id: "proxy", label: "Proxy", points: 25 }
        ]
      }
    });

    expect(parsed.mechanics).toMatchObject({ kind: "packet_capture", nodes: expect.arrayContaining([expect.objectContaining({ id: "dns" })]) });
  });

  it("rejects mechanics that do not match the content type", () => {
    const result = contentCreateSchema.safeParse({
      ...baseContent,
      type: "assessment",
      mechanics: {
        kind: "packet_capture",
        title: "Wrong shell",
        prompt: "This should not attach to an assessment.",
        nodes: [{ id: "dns", label: "DNS", points: 20 }]
      }
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid challenge defaults", () => {
    const result = contentCreateSchema.safeParse({
      ...baseContent,
      type: "challenge",
      mechanics: {
        kind: "challenge_path",
        title: "Choose a path",
        prompt: "Select a response path.",
        defaultPathId: "missing",
        paths: [{ id: "contain", label: "Contain", detail: "Isolate scope.", score: 80 }]
      }
    });

    expect(result.success).toBe(false);
  });

  it("accepts released case files and evidence artifacts for challenges", () => {
    const parsed = contentCreateSchema.parse({
      ...baseContent,
      type: "challenge",
      mechanics: {
        kind: "challenge_path",
        title: "Build the case",
        prompt: "Review released files and synthesize a working theory.",
        caseFiles: [
          {
            id: "case-brief",
            title: "Initial case brief",
            summary: "Victim report and timeline anchor.",
            releaseLabel: "Release 1",
            classification: "Training"
          }
        ],
        releases: [
          {
            id: "release-1",
            title: "Initial release",
            summary: "Case files stored in R2 for learner review.",
            releaseLabel: "Release 1",
            unlocked: true,
            files: [
              {
                key: "challenges/case-1/brief.pdf",
                title: "Case brief",
                description: "Initial release packet.",
                contentType: "application/pdf"
              }
            ],
            questionIds: ["theory-check"]
          }
        ],
        evidenceArtifacts: [
          {
            id: "headers",
            title: "Email headers",
            source: "Mailbox export",
            detail: "Relay path and authentication results.",
            releasedAt: "Day 2",
            tags: ["identity", "timeline"]
          }
        ],
        synthesisPrompts: [
          {
            id: "theory",
            label: "Working theory",
            prompt: "State the theory of compromise and supporting facts.",
            required: true
          }
        ],
        defaultPathId: "develop",
        paths: [{ id: "develop", label: "Develop case", detail: "Continue analysis with validated evidence.", score: 90 }]
      }
    });

    expect(parsed.mechanics).toMatchObject({
      kind: "challenge_path",
      releases: [expect.objectContaining({ id: "release-1", unlocked: true })],
      caseFiles: [expect.objectContaining({ id: "case-brief" })],
      evidenceArtifacts: [expect.objectContaining({ id: "headers" })],
      synthesisPrompts: [expect.objectContaining({ id: "theory" })]
    });
  });
});
