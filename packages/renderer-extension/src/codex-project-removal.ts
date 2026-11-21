import { loadCodexNativeServices } from "./codex-native-services.js";

interface ProjectServices {
  projects: {
    getLocalProjectsForRenderer(): Promise<Record<string, { rootPaths: string[] }>>;
    removeLocal(projectId: string): Promise<unknown>;
  };
}

function isProjectServices(value: unknown): value is ProjectServices {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "projects") &&
    Object.hasOwn(value, "appServerManagers") &&
    typeof (value as ProjectServices).projects?.removeLocal === "function" &&
    typeof (value as ProjectServices).projects?.getLocalProjectsForRenderer === "function"
  );
}

/** Use Desktop's removal transaction, including memberships, legacy state and native deletion.
 * Calling project/delete alone leaves Desktop's legacy catalog able to recreate the project. */
export async function removeCodexProject(
  owner: Window,
  projectId: string,
  path: string,
  importModule?: (url: string) => Promise<Record<string, unknown>>,
): Promise<void> {
  if (
    typeof projectId !== "string" ||
    !projectId ||
    projectId.length > 1_024 ||
    typeof path !== "string" ||
    !path
  )
    throw new Error("Invalid local project ID");
  const services = await loadCodexNativeServices(owner, isProjectServices, importModule);
  if (!services) throw new Error("Native project removal is unavailable. Update and open Desktop.");
  const project = (await services.projects.getLocalProjectsForRenderer())[projectId];
  if (!project || project.rootPaths.length !== 1 || project.rootPaths[0] !== path)
    throw new Error("The local project changed. Refresh before removing it.");
  await services.projects.removeLocal(projectId);
}
