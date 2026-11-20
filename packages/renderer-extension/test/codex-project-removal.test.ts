import { describe, expect, it } from "vitest";
import { removeCodexProject } from "../src/codex-project-removal.js";

function owner() {
  return {
    location: { href: "app://-/index.html" },
    document: { querySelectorAll: () => [{ getAttribute: () => "/assets/native.js" }] },
  } as unknown as Window;
}

describe("native project removal", () => {
  it("uses Desktop's project service transaction instead of a raw app-server deletion", async () => {
    const projects: Record<string, { rootPaths: string[] }> = {
      "legacy-project": { rootPaths: ["/missing-folder"] },
    };
    const services = {
      appServerManagers: {},
      projects: {
        async getLocalProjectsForRenderer() {
          return projects;
        },
        async removeLocal(id: string) {
          delete projects[id];
        },
      },
    };
    await removeCodexProject(owner(), "legacy-project", "/missing-folder", async () => ({
      services,
    }));
    expect(projects).toEqual({});
  });

  it("rejects unavailable or ambiguous owners, changed roots and native write failures", async () => {
    const remove = (load: () => Promise<Record<string, unknown>>) =>
      removeCodexProject(owner(), "id", "/folder", load);
    await expect(remove(async () => ({}))).rejects.toThrow("Native project removal is unavailable");
    const services = {
      appServerManagers: {},
      projects: {
        async getLocalProjectsForRenderer() {
          return { id: { rootPaths: ["/folder"] } };
        },
        async removeLocal() {
          throw new Error("Native write failed");
        },
      },
    };
    await expect(remove(async () => ({ services }))).rejects.toThrow("Native write failed");
    await expect(
      remove(async () => ({ first: services, second: { ...services } })),
    ).rejects.toThrow("native services are unavailable");
    const changed = {
      ...services,
      projects: {
        ...services.projects,
        async getLocalProjectsForRenderer() {
          return { id: { rootPaths: ["/folder", "/other"] } };
        },
      },
    };
    await expect(remove(async () => ({ services: changed }))).rejects.toThrow("project changed");
  });
});
