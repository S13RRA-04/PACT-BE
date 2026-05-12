import { AppError } from "../errors/AppError.js";

export type AgsScoreRequest = {
  lineItemUrl?: string;
  accessToken?: string;
  userId: string;
  score: number;
  maxScore: number;
  activityProgress: "Initialized" | "Started" | "InProgress" | "Completed";
  gradingProgress: "FullyGraded" | "Pending" | "PendingManual";
};

export class LmsAgsClient {
  async publishScore(request: AgsScoreRequest) {
    if (!request.lineItemUrl) {
      return "not_applicable" as const;
    }

    if (!request.accessToken) {
      return "pending" as const;
    }

    const response = await fetch(`${request.lineItemUrl}/scores`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/vnd.ims.lis.v1.score+json"
      },
      body: JSON.stringify({
        userId: request.userId,
        scoreGiven: request.score,
        scoreMaximum: request.maxScore,
        activityProgress: request.activityProgress,
        gradingProgress: request.gradingProgress,
        timestamp: new Date().toISOString()
      })
    });

    if (!response.ok) {
      throw new AppError(502, "AGS_PUBLISH_FAILED", "LMS AGS score publish failed");
    }

    return "published" as const;
  }
}
