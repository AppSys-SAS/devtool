import type { PullRequestChecks, PullRequestReview } from "@appsys/devtool-shared";
import { ForgeError, type GitForge, requestJson } from "./forge.js";
import type { ForgeRepository } from "./repository.js";

const QUERY = `query ($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft headRefName baseRefName updatedAt reviewDecision
        author { login }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

const CHECKS: Record<string, PullRequestChecks> = { SUCCESS: "success", PENDING: "pending", EXPECTED: "pending", FAILURE: "failure", ERROR: "failure" };

const REVIEWS: Record<string, PullRequestReview> = { APPROVED: "approved", CHANGES_REQUESTED: "changesRequested", REVIEW_REQUIRED: "required" };

interface GithubPullRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  reviewDecision: string | null;
  author: { login: string } | null;
  reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

interface GithubAnswer {
  data?: { viewer: { login: string }; repository: { pullRequests: { nodes: GithubPullRequest[] } } | null };
  errors?: { message: string }[];
}

/** GitHub and GitHub Enterprise Server, read through their GraphQL API. */
export const github: GitForge = {
  name: "github",
  label: "GitHub",
  icon: "simple-icons:github",

  matches(host) {
    return host === "github.com" || host.startsWith("github.");
  },

  async pullRequests(repository: ForgeRepository, token: string | null) {
    if (!token) {
      throw new ForgeError(401, "GitHub needs a token to read pull requests");
    }
    const [owner, name, ...rest] = repository.path.split("/");
    if (rest.length) {
      throw new ForgeError(400, `GitHub repositories are <owner>/<name>, not ${repository.path}`);
    }

    const endpoint = repository.host === "github.com" ? "https://api.github.com/graphql" : `${new URL(repository.webUrl).origin}/api/graphql`;
    const answer = await requestJson<GithubAnswer>("GitHub", endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { owner, name } }),
    });
    if (answer.errors?.length || !answer.data?.repository) {
      throw new ForgeError(200, `GitHub: ${answer.errors?.map((error) => error.message).join(", ") || `no repository ${repository.path}`}`);
    }

    const viewer = answer.data.viewer.login;
    return {
      viewer,
      items: answer.data.repository.pullRequests.nodes.map((pullRequest) => {
        const checks = pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.state;
        return {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          author: pullRequest.author?.login ?? null,
          branch: pullRequest.headRefName,
          base: pullRequest.baseRefName,
          draft: pullRequest.isDraft,
          updatedAt: pullRequest.updatedAt,
          checks: checks ? (CHECKS[checks] ?? null) : null,
          review: pullRequest.reviewDecision ? (REVIEWS[pullRequest.reviewDecision] ?? null) : null,
          reviewRequested: pullRequest.reviewRequests.nodes.some((request) => request.requestedReviewer?.login === viewer),
          mine: pullRequest.author?.login === viewer,
        };
      }),
    };
  },
};
