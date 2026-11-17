import type { RouteLocationRaw } from "vue-router";
import type { DirectoryDefinition, DirectoryShortcut, IntegrationDefinition } from "@appsys/devtool-shared";
import router from "@/router";
import { commandName, iconFromMeta, runDirectoryCommand, startDefaultCommand } from "@/lib/directory-commands";

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
}

/**
 * Gives the page of the devtool showing an integration.
 * @param integration The integration.
 * @param projectSlug The project of the directory declaring it, if any.
 * @param directorySlug The directory declaring it, if any.
 * @returns Its route, under the directory declaring it when there is one.
 */
export function integrationRoute(integration: IntegrationDefinition, projectSlug?: string, directorySlug?: string): RouteLocationRaw {
  if (projectSlug && directorySlug) {
    return { name: "directory-integration", params: { projectSlug, directorySlug, integration: integration.slug } };
  }
  return { name: "integration", params: { integration: integration.slug } };
}

/**
 * Gives the shortcut opening an integration: its page when embedded, else its URL in a new tab.
 * @param integration The integration.
 * @param projectSlug The project of the directory declaring it, if any.
 * @param directorySlug The directory declaring it, if any.
 * @returns The shortcut.
 */
export function integrationShortcut(integration: IntegrationDefinition, projectSlug?: string, directorySlug?: string): SidebarShortcut {
  const route = integration.embed ? integrationRoute(integration, projectSlug, directorySlug) : null;
  return {
    key: `integration:${integration.slug}`,
    name: integration.name,
    icon: integration.icon,
    route,
    open: () => (route ? void router.push(route) : openTab(integration.url)),
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
      return files ? [{ key, name: files.name, icon: "lucide:folder-open", route, open: () => void router.push(route) }] : [];
    }
    const host = directory.loadBalancer[shortcut.slug]?.hosts[shortcut.index];
    return host ? [{ key, name: host, icon: "lucide:globe", route: null, open: () => openTab(`https://${host}`) }] : [];
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
