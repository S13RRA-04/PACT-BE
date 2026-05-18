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
});
