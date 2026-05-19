import { AppError } from "../errors/AppError.js";

export type AgsScoreRequest = {
  lineItemUrl?: string;
  accessToken?: string;
  userId: string;
  score: number;
  maxScore: number;
  activityProgress: "Initialized" | "Started" | "InProgress" | "Completed";
  gradingProgress: "FullyGraded" | "Pending" | "PendingManual";
  comment?: string;
};

export type AgsLineItemRequest = {
  lineItemsUrl: string;
  accessToken: string;
  label: string;
  scoreMaximum: number;
  resourceId: string;
  tag: string;
};

type AgsLineItem = {
  id: string;
  label: string;
  scoreMaximum: number;
  resourceId?: string;
  tag?: string;
};

export class LmsAgsClient {
  async findOrCreateLineItem(request: AgsLineItemRequest) {
    const existing = await this.listLineItems(request.lineItemsUrl, request.accessToken);
    const match = existing.find((item) => item.resourceId === request.resourceId && item.tag === request.tag);
    if (match) {
      return lineItemUrl(request.lineItemsUrl, match.id);
    }

    const response = await fetch(request.lineItemsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/vnd.ims.lis.v2.lineitem+json"
      },
      body: JSON.stringify({
        label: request.label,
        scoreMaximum: request.scoreMaximum,
        resourceId: request.resourceId,
        tag: request.tag
      })
    });

    if (!response.ok) {
      throw new AppError(502, "AGS_LINE_ITEM_CREATE_FAILED", "LMS AGS line item creation failed");
    }

    const created = await response.json() as AgsLineItem;
    return lineItemUrl(request.lineItemsUrl, created.id);
  }

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
        ...(request.comment ? { comment: request.comment } : {}),
        timestamp: new Date().toISOString()
      })
    });

    if (!response.ok) {
      throw new AppError(502, "AGS_PUBLISH_FAILED", "LMS AGS score publish failed");
    }

    return "published" as const;
  }

  private async listLineItems(lineItemsUrl: string, accessToken: string) {
    const response = await fetch(lineItemsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      throw new AppError(502, "AGS_LINE_ITEM_LIST_FAILED", "LMS AGS line item lookup failed");
    }
    return await response.json() as AgsLineItem[];
  }
}

function lineItemUrl(lineItemsUrl: string, id: string) {
  return `${lineItemsUrl.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
}
