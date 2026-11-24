import { ref } from "vue";
import type { PullRequestsPayload } from "@appsys/devtool-shared";

/**
 * Open pull requests of the integrations of the projects, as the server last read them.
 */
class PullRequestsStore {
  states = ref<Record<string, PullRequestsPayload>>({});

  /**
   * Takes the state sent by the server.
   * @param payload The pull requests of each integration, empty once disconnected from the server.
   */
  load(payload: PullRequestsPayload[]): void {
    this.states.value = Object.fromEntries(payload.map((state) => [state.key, state]));
  }

  /**
   * Gives the pull requests of an integration.
   * @param key The integration, `<section>/<project>/<slug>`.
   * @returns Its state, null before the server sends it.
   */
  get(key: string): PullRequestsPayload | null {
    return this.states.value[key] ?? null;
  }
}

export default new PullRequestsStore();
