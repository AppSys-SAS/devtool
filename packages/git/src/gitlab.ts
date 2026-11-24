import type { PullRequestReview } from "@appsys/devtool-shared";
import { type GitForge, requestJson } from "./forge.js";
import type { ForgeRepository } from "./repository.js";

const REVIEWS: Record<string, PullRequestReview> = { requested_changes: "changesRequested", not_approved: "required" };

interface GitlabMergeRequest {
  iid: number;
  title: string;
  web_url: string;
  draft: boolean;
  source_branch: string;
  target_branch: string;
  updated_at: string;
  detailed_merge_status: string | null;
  author: { username: string } | null;
  reviewers: { username: string }[] | null;
}

/** GitLab, hosted or on gitlab.com, read through its REST API. */
export const gitlab: GitForge = {
  name: "gitlab",
  label: "GitLab",
  icon: "simple-icons:gitlab",

  matches(host) {
    return host === "gitlab.com" || host.startsWith("gitlab.");
  },

  async pullRequests(repository: ForgeRepository, token: string | null) {
    const api = `${new URL(repository.webUrl).origin}/api/v4`;
    const init: RequestInit = token ? { headers: { "PRIVATE-TOKEN": token } } : {};
    const [user, mergeRequests] = await Promise.all([
      token ? requestJson<{ username: string }>("GitLab", `${api}/user`, init) : Promise.resolve(null),
      requestJson<GitlabMergeRequest[]>(
        "GitLab",
        `${api}/projects/${encodeURIComponent(repository.path)}/merge_requests?state=opened&per_page=50&order_by=updated_at&sort=desc`,
        init,
      ),
    ]);

    const viewer = user?.username ?? null;
    return {
      viewer,
      items: mergeRequests.map((mergeRequest) => ({
        number: mergeRequest.iid,
        title: mergeRequest.title,
        url: mergeRequest.web_url,
        author: mergeRequest.author?.username ?? null,
        branch: mergeRequest.source_branch,
        base: mergeRequest.target_branch,
        draft: mergeRequest.draft,
        updatedAt: mergeRequest.updated_at,
        checks: mergeRequest.detailed_merge_status === "ci_still_running" ? "pending" : null,
        review: REVIEWS[mergeRequest.detailed_merge_status ?? ""] ?? null,
        reviewRequested: viewer !== null && (mergeRequest.reviewers ?? []).some((reviewer) => reviewer.username === viewer),
        mine: viewer !== null && mergeRequest.author?.username === viewer,
      })),
    };
  },
};
