import type { RouteLocationRaw } from "vue-router";
import type { DirectoryDefinition, DirectoryShortcut, IntegrationDefinition, ProjectDefinition } from "@appsys/devtool-shared";
import { integrationKey } from "@appsys/devtool-shared";
import router from "@/router";
import { commandName, iconFromMeta, runDirectoryCommand, startDefaultCommand } from "@/lib/directory-commands";
import pullRequestsStore from "@/stores/pull-requests";

const GENERIC_INTEGRATION_ICON = "lucide:app-window";

/** Something the sidebar offers in one click, as an icon or a row. */
export interface SidebarShortcut {
  key: string;
  name: string;
  /** Iconify name of its icon. */
  icon: string;
  /** The page of the devtool it shows, null when it opens a tab or runs a command. */
  route: RouteLocationRaw | null;
  open: () => void;
  /** A number shown with it, such as what waits for the person, absent when there is none. */
  count?: number;
}

/**
 * Gives the page of the devtool showing an integration.
 * @param integration The integration.
 * @param projectSlug The project declaring it, or holding the directory declaring it, if any.
 * @param directorySlug The directory declaring it, if any.
 * @returns Its route, under the project or the directory declaring it when there is one.
 */
export function integrationRoute(integration: IntegrationDefinition, projectSlug?: string, directorySlug?: string): RouteLocationRaw {
  if (projectSlug && directorySlug) {
    return { name: "directory-integration", params: { projectSlug, directorySlug, integration: integration.slug } };
  }
  if (projectSlug) {
    return { name: "project-integration", params: { projectSlug, integration: integration.slug } };
  }
  return { name: "integration", params: { integration: integration.slug } };
}

/**
 * Tells whether an integration is shown in a page of the devtool rather than opened in a new tab.
 * @param integration The integration.
 * @returns Whether it has a page: embedded, or listing pull requests.
 */
export function hasIntegrationPage(integration: IntegrationDefinition): boolean {
  return integration.embed || integration.type === "pullRequests";
}

/**
 * Gives the shortcut opening an integration: its page when embedded or listing pull requests, else its
 * URL in a new tab; pull requests count those waiting for a review of the person, unless `badge` is off.
 * @param integration The integration.
 * @param projectSlug The project declaring it, or holding the directory declaring it, if any.
 * @param directorySlug The directory declaring it, if any.
 * @returns The shortcut.
 */
export function integrationShortcut(integration: IntegrationDefinition, projectSlug?: string, directorySlug?: string): SidebarShortcut {
  const route = hasIntegrationPage(integration) ? integrationRoute(integration, projectSlug, directorySlug) : null;
  const state = integration.badge && projectSlug ? pullRequestsStore.get(integrationKey(projectSlug, directorySlug ?? null, integration.slug)) : null;
  const waiting = state?.items.filter((item) => item.reviewRequested).length ?? 0;
  return {
    key: `integration:${integration.slug}`,
    name: integration.name,
    icon: integration.icon,
    route,
    open: () => (route ? void router.push(route) : openTab(integration.url)),
    ...(waiting ? { count: waiting } : {}),
  };
}

/**
 * Turns the shortcuts a directory declares into what the sidebar shows.
 * @param projectSlug The project of the directory.
 * @param directory The directory.
 * @param shortcuts Its icons or lines.
 * @returns The shortcuts, in order, without those naming nothing.
 */
export function directoryShortcuts(projectSlug: string, directory: DirectoryDefinition, shortcuts: DirectoryShortcut[]): SidebarShortcut[] {
  return shortcuts.flatMap((shortcut): SidebarShortcut[] => {
    const key = `${shortcut.type}:${shortcut.slug}:${shortcut.index}`;
    if (shortcut.type === "integration") {
      const integration = directory.integrations.find((item) => item.slug === shortcut.slug);
      return integration ? [integrationShortcut(integration, projectSlug, directory.slug)] : [];
    }
    if (shortcut.type === "command") {
      const command = directory.extras[shortcut.slug];
      return command ? [{ key, name: commandName(command), icon: iconFromMeta(command.meta), route: null, open: () => runDirectoryCommand(projectSlug, directory.slug, command) }] : [];
    }
    if (shortcut.type === "files") {
      const files = directory.files[shortcut.slug];
      const route = { name: "directory-files", params: { projectSlug, directorySlug: directory.slug, fileSpace: shortcut.slug } };
      const icon = files?.type === "agentSkills" ? "lucide:sparkles" : "lucide:folder-open";
      return files ? [{ key, name: files.name, icon, route, open: () => void router.push(route) }] : [];
    }
    const host = directory.loadBalancer[shortcut.slug]?.hosts[shortcut.index];
    return host ? [{ key, name: host, icon: "lucide:globe", route: null, open: () => openTab(`https://${host}`) }] : [];
  });
}

/**
 * Turns the shortcuts a project declares, its integrations only, into what the sidebar shows.
 * @param project The project.
 * @param shortcuts Its icons or lines.
 * @returns The shortcuts, in order, without those naming nothing.
 */
export function projectShortcuts(project: ProjectDefinition, shortcuts: DirectoryShortcut[]): SidebarShortcut[] {
  return shortcuts.flatMap((shortcut) => {
    const integration = shortcut.type === "integration" ? project.integrations.find((item) => item.slug === shortcut.slug) : undefined;
    return integration ? [integrationShortcut(integration, project.slug)] : [];
  });
}

/**
 * Gives the shortcut doing what a directory does by default, a command starting as its main command.
 * @param projectSlug The project of the directory.
 * @param directory The directory.
 * @returns The shortcut, null when the directory declares no default action.
 */
export function defaultShortcut(projectSlug: string, directory: DirectoryDefinition): SidebarShortcut | null {
  const action = directory.defaultAction;
  if (!action) {
    return null;
  }
  const shortcut =
    action.shortcut.type === "command"
      ? { key: "default", name: directory.name, icon: "lucide:play", route: null, open: () => startDefaultCommand(projectSlug, directory) }
      : directoryShortcuts(projectSlug, directory, [action.shortcut])[0];
  if (!shortcut) {
    return null;
  }
  if (action.icon && action.icon !== "own") {
    return { ...shortcut, icon: action.icon };
  }
  return action.shortcut.type === "integration" && action.icon !== "own" ? { ...shortcut, icon: GENERIC_INTEGRATION_ICON } : shortcut;
}

/**
 * Opens a URL in a new tab of the browser.
 * @param url The URL.
 */
function openTab(url: string): void {
  window.open(url, "_blank", "noopener");
}
