import type { AgentDefinition } from "@appsys/devtool-shared";
import { agentUrl } from "@appsys/devtool-shared";
import wsStore from "@/stores/ws";

/** Where an agent works: a project, or one of its directories, and its folder. */
export interface AgentPlace {
  projectSlug: string;
  /** The directory, null for the project itself. */
  directorySlug: string | null;
  path: string;
}

/**
 * Starts an agent with a prompt: its command in a terminal of the place, shown once started, or its
 * link, a web page in a new tab and any other link handed to the application registered for it.
 * @param agent The agent.
 * @param place Where the agent works.
 * @param prompt The prompt.
 * @param name The name of the terminal.
 */
export function startAgent(agent: AgentDefinition, place: AgentPlace, prompt: string, name: string): void {
  if (agent.args) {
    wsStore.agentStart(agent.slug, place.projectSlug, place.directorySlug, prompt, name);
    return;
  }
  const url = agentUrl(agent, prompt, place.path);
  if (/^https?:/i.test(url)) {
    window.open(url, "_blank", "noopener");
  } else {
    window.location.assign(url);
  }
}
