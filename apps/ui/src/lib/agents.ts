import type { AgentDefinition, DirectoryDefinition } from "@appsys/devtool-shared";
import { agentUrl } from "@appsys/devtool-shared";
import wsStore from "@/stores/ws";

/**
 * Starts an agent with a prompt in a directory: its command in a terminal of the directory, shown
 * once started, or its link, a web page in a new tab and any other link handed to the application
 * registered for it.
 * @param agent The agent.
 * @param projectSlug The project of the directory.
 * @param directory The directory the agent works in.
 * @param prompt The prompt.
 * @param name The name of the terminal.
 */
export function startAgent(agent: AgentDefinition, projectSlug: string, directory: DirectoryDefinition, prompt: string, name: string): void {
  if (agent.args) {
    wsStore.agentStart(agent.slug, projectSlug, directory.slug, prompt, name);
    return;
  }
  const url = agentUrl(agent, prompt, directory.path);
  if (/^https?:/i.test(url)) {
    window.open(url, "_blank", "noopener");
  } else {
    window.location.assign(url);
  }
}
