import { AppError } from "../errors/AppError.js";

type LinearGraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: {
    name?: string;
    type?: string;
  };
};

export type CreatedLinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: string;
};

export class LinearClient {
  private readonly endpoint = "https://api.linear.app/graphql";
  private lookupCache: Promise<{ teamId: string; projectId?: string }> | undefined;

  constructor(
    private readonly apiKey: string,
    private readonly teamKey: string,
    private readonly projectName?: string
  ) {}

  async createBugIssue(input: { title: string; description: string; severity: string }): Promise<CreatedLinearIssue> {
    const { teamId, projectId } = await this.lookupIds();
    const response = await this.graphql<{
      issueCreate: {
        success: boolean;
        issue?: LinearIssue;
      };
    }>(
      `mutation PactBugIssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            title
            url
            state {
              name
              type
            }
          }
        }
      }`,
      {
        input: {
          teamId,
          projectId,
          title: input.title,
          description: input.description,
          priority: priorityForSeverity(input.severity)
        }
      }
    );

    const issue = response.issueCreate.issue;
    if (!response.issueCreate.success || !issue) {
      throw new AppError(502, "LINEAR_ISSUE_CREATE_FAILED", "Linear did not create a bug issue");
    }

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: issue.state?.name ?? issue.state?.type
    };
  }

  private async lookupIds() {
    this.lookupCache ??= this.loadLookupIds();
    return this.lookupCache;
  }

  private async loadLookupIds() {
    const response = await this.graphql<{
      teams: { nodes: Array<{ id: string; key: string; name: string }> };
      projects: { nodes: Array<{ id: string; name: string }> };
    }>(
      `query PactBugLinearLookup {
        teams {
          nodes {
            id
            key
            name
          }
        }
        projects(first: 100) {
          nodes {
            id
            name
          }
        }
      }`,
      {}
    );

    const team = response.teams.nodes.find((item) => item.key.toLowerCase() === this.teamKey.toLowerCase());
    if (!team) {
      throw new AppError(502, "LINEAR_TEAM_NOT_FOUND", "Configured Linear team was not found");
    }

    const project = this.projectName
      ? response.projects.nodes.find((item) => item.name.toLowerCase() === this.projectName?.toLowerCase())
      : undefined;
    if (this.projectName && !project) {
      throw new AppError(502, "LINEAR_PROJECT_NOT_FOUND", "Configured Linear project was not found");
    }

    return { teamId: team.id, projectId: project?.id };
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.apiKey
      },
      body: JSON.stringify({ query, variables })
    });

    const payload = await response.json().catch(() => undefined) as LinearGraphqlResponse<T> | undefined;
    if (!response.ok || !payload) {
      throw new AppError(502, "LINEAR_UNAVAILABLE", "Linear API is temporarily unavailable");
    }
    if (payload.errors?.length) {
      throw new AppError(502, "LINEAR_GRAPHQL_ERROR", payload.errors[0]?.message ?? "Linear API returned an error");
    }
    if (!payload.data) {
      throw new AppError(502, "LINEAR_EMPTY_RESPONSE", "Linear API returned an empty response");
    }

    return payload.data;
  }
}

function priorityForSeverity(severity: string) {
  if (severity === "critical") return 1;
  if (severity === "high") return 2;
  if (severity === "medium") return 3;
  return 4;
}
