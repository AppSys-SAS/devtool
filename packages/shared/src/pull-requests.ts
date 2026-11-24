import { replaceVariables } from "./command-args.js";
import type { AgentDefinition, PullRequestPayload } from "./types.js";

/** The prompt given to an agent reviewing a pull request when the integration declares none. */
export const DEFAULT_REVIEW_PROMPT =
  'Review the pull request %{ADT:PR_URL} (#%{ADT:PR_NUMBER} "%{ADT:PR_TITLE}", %{ADT:PR_BRANCH} into %{ADT:PR_BASE}). ' +
  "Read its changes without checking out its branch, then list the problems you find by file and line, the most severe first.";

/**
 * Writes the prompt of the review of a pull request.
 * @param template The prompt, `%{ADT:PR_URL}`, `PR_NUMBER`, `PR_TITLE`, `PR_BRANCH`, `PR_BASE` and `PR_AUTHOR` standing for the pull request.
 * @param pullRequest The pull request.
 * @returns The prompt.
 */
export function pullRequestPrompt(template: string, pullRequest: PullRequestPayload): string {
  return replaceVariables(template, {
    PR_URL: pullRequest.url,
    PR_NUMBER: String(pullRequest.number),
    PR_TITLE: pullRequest.title,
    PR_BRANCH: pullRequest.branch,
    PR_BASE: pullRequest.base,
    PR_AUTHOR: pullRequest.author ?? "",
  });
}

/**
 * Builds the link starting an agent, its variables encoded.
 * @param agent The agent, started by a link.
 * @param prompt The prompt.
 * @param cwd The folder the agent works in.
 * @returns The link.
 */
export function agentUrl(agent: AgentDefinition, prompt: string, cwd: string): string {
  return replaceVariables(agent.url ?? "", { PROMPT: prompt, CWD: cwd }, encodeURIComponent);
}
