import {
  harnessInspectionSchema,
  threadInspectionSchema,
  threadOwnershipListResultSchema,
} from "@codexhost/shared-contracts";
import {
  createDesktopScheduleManagement,
  type DesktopHarnessSchedules,
  type DesktopScheduleManagementServices,
} from "./desktop-harness-schedule-management.js";
import {
  discoverRendererHosts,
  type RendererHostRoot,
  type RendererHostRegistry,
} from "./renderer-host-discovery.js";
import type { RendererHostRouting } from "./renderer-host-routing.js";
import {
  createDesktopHarnessScheduleSession,
  DesktopScheduleRejectedError,
  type DesktopScheduleServices,
} from "./desktop-harness-schedule-creation.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null;
interface Scope {
  get(atom: unknown, key: string): unknown;
  queryClient: { invalidateQueries(input: { queryKey: unknown }): Promise<unknown> };
}
interface NativeManager {
  getHostId(): string;
  createProjectlessThreadWorkspace(title: string): Promise<{ cwd: string; workspaceRoot: string }>;
  startConversation(input: unknown, options: unknown): Promise<unknown>;
  sendRequest(method: string, input: unknown): Promise<unknown>;
  getConversation(threadId: string): unknown;
}
interface ReviewedModules {
  shared: RecordValue;
  initial: RecordValue;
  primary: RecordValue;
}
const assets = {
  shared: "app-shared-2cae01273bae.js",
  initial: "app-initial-feb30b196d11.js",
  primary: "app-primary-7d7313419f84.js",
} as const;

/** Exact module exports reviewed in Desktop 26.1021.31345. Other builds fail
 * closed rather than searching for arbitrary callable objects. */
export async function connectDesktopHarnessSchedules(
  root: RendererHostRoot & { baseURI: string },
  routing: RendererHostRouting,
): Promise<DesktopHarnessSchedules> {
  const modules = Object.fromEntries(
    await Promise.all(
      Object.entries(assets).map(async ([key, name]) => {
        const url = new URL(`./assets/${name}`, root.baseURI).href;
        return [key, (await import(/* @vite-ignore */ url)) as RecordValue];
      }),
    ),
  ) as unknown as ReviewedModules;
  let discovery = discoverRendererHosts(root);
  // Native settings destinations may have no Composer. Their main content
  // still descends from the same Host registry provider.
  if (discovery.registries.length === 0)
    discovery = discoverRendererHosts({ querySelectorAll: () => root.querySelectorAll("main") });
  const route = routing.forHost("local");
  const services = bindReviewedDesktopScheduleServices(
    modules,
    resolveDesktopScheduleScope(discovery.registries, route?.manager),
    routing,
  );
  return {
    createSession: () => createDesktopHarnessScheduleSession(services),
    ...createDesktopScheduleManagement(services),
  };
}

export function resolveDesktopScheduleScope(
  registries: readonly RendererHostRegistry[],
  manager: unknown,
): unknown {
  const scopes = new Set(
    registries.flatMap((registry) => {
      try {
        return manager && registry.getForHostId("local") === manager
          ? [(registry as unknown as RecordValue).scope]
          : [];
      } catch {
        return [];
      }
    }),
  );
  if (scopes.size !== 1) throw new Error("Desktop local chat service is missing or ambiguous");
  return scopes.values().next().value;
}

/** Kept internal to desktop-control; fixtures exercise the reviewed service
 * shape without starting a real task or replacing native scheduler policy. */
export function bindReviewedDesktopScheduleServices(
  modules: ReviewedModules,
  candidateScope: unknown,
  routing: RendererHostRouting,
): DesktopScheduleServices & DesktopScheduleManagementServices {
  const { shared, initial, primary } = modules;
  const route = routing.forHost("local");
  const candidate = route?.manager as unknown;
  const services = shared.Qot;
  if (
    !route?.policy.scopedCreation ||
    !record(candidate) ||
    !record(candidateScope) ||
    typeof candidateScope.get !== "function" ||
    !record(candidateScope.queryClient) ||
    typeof candidateScope.queryClient.invalidateQueries !== "function" ||
    !record(services) ||
    !services.localAutomationsScheduler ||
    !record(services.localAutomations) ||
    typeof services.localAutomations.create !== "function" ||
    !["list", "update", "delete"].every(
      (key) => typeof (services.localAutomations as RecordValue)[key] === "function",
    ) ||
    !record(services.projectlessThreads) ||
    typeof services.projectlessThreads.createPaths !== "function" ||
    typeof shared.Yat !== "function" ||
    typeof initial.GW !== "function" ||
    typeof initial.irr !== "function" ||
    !initial.xSn ||
    !primary.OT ||
    !Array.isArray(initial.jzn) ||
    initial.jzn.join("/") !== "vscode/list-automations" ||
    ![
      "getHostId",
      "createProjectlessThreadWorkspace",
      "startConversation",
      "sendRequest",
      "getConversation",
    ].every((key) => typeof candidate[key] === "function")
  )
    throw new Error(
      "This Desktop build does not expose the required local schedule and chat services",
    );
  const scope = candidateScope as unknown as Scope;
  const manager = candidate as unknown as NativeManager;
  const resolveManager = initial.irr as (scope: Scope, host: string) => unknown;
  const creationInputs = initial.GW as (
    scope: Scope,
    host: string,
  ) => { readCreationInputs(input: unknown, mode: unknown): unknown };
  const unwrap = shared.Yat as (value: unknown) => Promise<unknown>;
  const automations = services.localAutomations as {
    create(input: unknown): unknown;
    list(): unknown;
    update(input: unknown): unknown;
    delete(input: { id: string }): unknown;
  };
  const assertAvailable = () => {
    if (
      manager.getHostId() !== "local" ||
      routing.forHost("local") !== route ||
      resolveManager(scope, "local") !== manager
    )
      throw new Error("The local Desktop connection changed; reopen schedule creation");
  };
  assertAvailable();
  return {
    assertAvailable,
    listAutomations: () => unwrap(automations.list()),
    updateAutomation: (input) => unwrap(automations.update(input)),
    deleteAutomation: (id) => unwrap(automations.delete({ id })),
    async readOwnership(threadId) {
      const { threads } = threadOwnershipListResultSchema.parse(
        await manager.sendRequest("codexhost/thread/ownership/list", { threadIds: [threadId] }),
      );
      const owner = threads.find((thread) => thread.threadId === threadId);
      if (!owner) throw new Error("Thread ownership response is missing");
      return owner;
    },
    async inspect(input) {
      return harnessInspectionSchema.parse(
        await manager.sendRequest("codexhost/harness/inspect", {
          harnessId: input.harnessId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        }),
      );
    },
    allocate: (title) => manager.createProjectlessThreadWorkspace(title),
    async validateDirectory(cwd) {
      const listing = await manager.sendRequest("fs/readDirectory", { path: cwd });
      if (!record(listing) || !Array.isArray(listing.entries))
        throw new Error("The working directory could not be verified");
    },
    createThread({ cwd, workspaceRoot, projectless, model, title }) {
      return route.policy.createScheduledConversation(
        {
          cwd,
          workspaceRoots: [workspaceRoot],
          workspaceKind: projectless ? "projectless" : "project",
          initialTitle: title,
          ...(projectless ? { projectlessOutputDirectory: cwd } : {}),
          collaborationMode: {
            mode: "default",
            settings: { model, reasoning_effort: null, developer_instructions: null },
          },
        },
        (input: unknown, mode: unknown) =>
          creationInputs(scope, "local").readCreationInputs(input, mode),
      );
    },
    async inspectThread(threadId) {
      return threadInspectionSchema.parse(
        await manager.sendRequest("codexhost/thread/inspect", { threadId }),
      );
    },
    isThreadReady(threadId) {
      const conversation = manager.getConversation(threadId);
      const mode = scope.get(initial.xSn, threadId);
      const eligible = scope.get(primary.OT, threadId);
      return (
        record(conversation) &&
        conversation.resumeState === "resumed" &&
        record(conversation.currentPermissions) &&
        record(mode) &&
        record(mode.settings) &&
        typeof mode.settings.model === "string" &&
        mode.settings.model.length > 0 &&
        record(eligible) &&
        eligible.isEligible === true
      );
    },
    async save(input) {
      try {
        return await unwrap(automations.create(input));
      } catch (error) {
        // These reviewed errors originate before the native service writes.
        // All transport and other persistence failures have unknown outcomes.
        if (
          error instanceof Error &&
          [
            "Couldn’t verify this chat for scheduled updates. Try again, or open another chat and set up the schedule there.",
            "Scheduled updates can’t run in temporary side chats. Open the main chat or start a new chat, then set up the schedule there.",
          ].includes(error.message)
        )
          throw new DesktopScheduleRejectedError(error.message);
        throw error;
      }
    },
    async refreshList() {
      await scope.queryClient.invalidateQueries({ queryKey: initial.jzn });
    },
  };
}
