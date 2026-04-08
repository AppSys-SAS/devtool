import router from "./index";

export function getStreamRoute(projectSlug: string | null, directorySlug: string | null, streamSlug: string, isPrimary: boolean): {
  name: string;
  params: Record<string, string>;
} {
  let name = "directory-stream";
  const params: Record<string, string> = {
    projectSlug: projectSlug ?? "",
    directorySlug: directorySlug ?? "",
    streamSlug,
  };

  if (!directorySlug) {
    name = "project-stream";
    delete params.directorySlug;
  }

  if (!projectSlug) {
    name = "stream";
    delete params.projectSlug;
  }

  if (name === "directory-stream" && isPrimary) {
    name = "directory";
    delete params.streamSlug;
  }

  return { name, params };
}

export function isCurrentRoute(route: { name: string; params: Record<string, string> }): boolean {
  const currentRoute = router.currentRoute.value;
  if (currentRoute.name !== route.name) {
    return false;
  }

  const current = currentRoute.params as Record<string, string>;
  for (const key of Object.keys(route.params)) {
    if (route.params[key] !== current[key]) {
      return false;
    }
  }

  for (const key of Object.keys(current)) {
    if (route.params[key] !== current[key]) {
      return false;
    }
  }

  return true;
}
