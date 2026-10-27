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
  requestClient: unknown;
  getHostId(): string;
  createProjectlessThreadWorkspace(title: string): Promise<{ cwd: string; workspaceRoot: string }>;
  startConversation(input: unknown, options: unknown): Promise<unknown>;
  sendRequest(method: string, input: unknown): Promise<unknown>;
  getConversation(threadId: string): unknown;
}
/** Only the native operations used by this page cross the Renderer boundary. */
export interface DesktopScheduleNativeServices {
  localAutomations: {
    list(): unknown;
    update(input: unknown): unknown;
    delete(input: { id: string }): unknown;
    create?(input: unknown): unknown;
  };
  isPrimaryWindow: boolean;
}
export type DesktopScheduleCreationInputsFactory = (scope: unknown, hostId: string) => unknown;
interface CreationInputs {
  readCreationInputs(input: unknown, mode: unknown): unknown;
}

export async function connectDesktopHarnessSchedules(
  root: RendererHostRoot,
  routing: RendererHostRouting,
  native: DesktopScheduleNativeServices,
  creationInputsFactory: DesktopScheduleCreationInputsFactory | null,
): Promise<DesktopHarnessSchedules> {
  let discovery = discoverRendererHosts(root);
  if (discovery.registries.length === 0)
    discovery = discoverRendererHosts({ querySelectorAll: () => root.querySelectorAll("main") });
  const route = routing.forHost("local");
  const services = bindReviewedDesktopScheduleServices(
    native,
    resolveDesktopScheduleScope(discovery.registries, route?.manager),
    routing,
    creationInputsFactory,
  );
  return {
    ...(services.creationUnavailableReason
      ? { creationUnavailableReason: services.creationUnavailableReason }
      : {}),
    createSession: () =>
      createDesktopHarnessScheduleSession({
        ...services,
        assertAvailable: services.assertCreationAvailable,
      }),
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
  if (scopes.size !== 1)
    throw new Error("Local Desktop Host registry scope is missing or ambiguous in this window");
  return scopes.values().next().value;
}

/** RPC calls are disposable thenables in Desktop, including callable proxies. */
async function nativeResult(value: unknown): Promise<unknown> {
  try {
    return await value;
  } finally {
    (value as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose]?.();
  }
}

export function bindReviewedDesktopScheduleServices(
  native: DesktopScheduleNativeServices,
  candidateScope: unknown,
  routing: RendererHostRouting,
  creationInputsFactory: DesktopScheduleCreationInputsFactory | null = null,
): DesktopScheduleServices &
  DesktopScheduleManagementServices & {
    creationUnavailableReason: string | null;
    assertCreationAvailable(): void;
  } {
  const route = routing.forHost("local");
  const candidate = route?.manager as unknown;
  const automations = native.localAutomations;
  const missing: string[] = [];
  if (!record(candidate)) missing.push("local Host manager");
  for (const key of ["getHostId", "sendRequest"])
    if (!record(candidate) || typeof candidate[key] !== "function") missing.push(`manager.${key}`);
  if (
    !record(candidateScope) ||
    !record(candidateScope.queryClient) ||
    typeof candidateScope.queryClient.invalidateQueries !== "function"
  )
    missing.push("Host scope.queryClient.invalidateQueries");
  for (const key of ["list", "update", "delete"] as const)
    if (typeof automations?.[key] !== "function") missing.push(`localAutomations.${key}`);
  if (missing.length)
    throw new Error(`Local schedule management is unavailable: missing ${missing.join(", ")}`);
  const scope = candidateScope as unknown as Scope;
  const manager = candidate as unknown as NativeManager;
  const assertAvailable = () => {
    if (manager.getHostId() !== "local" || routing.forHost("local")?.manager !== candidate)
      throw new Error("The local Desktop Host connection changed; reopen the schedules page");
  };
  assertAvailable();

  const creationMissing: string[] = [];
  if (!native.isPrimaryWindow) creationMissing.push("main-window heartbeat observer");
  if (!route?.policy.scopedCreation) creationMissing.push("scoped empty-chat/prewarm binding");
  for (const key of ["createProjectlessThreadWorkspace", "startConversation", "getConversation"])
    if (typeof (candidate as RecordValue)[key] !== "function")
      creationMissing.push(`manager.${key}`);
  if (typeof scope.get !== "function") creationMissing.push("Host scope.get");
  if (typeof automations.create !== "function") creationMissing.push("localAutomations.create");
  let reader: CreationInputs | null = null;
  if (!creationInputsFactory)
    creationMissing.push("native chat creation-input factory (missing or ambiguous)");
  else if (!creationMissing.length) {
    try {
      const value = creationInputsFactory(scope, "local");
      if (
        !record(value) ||
        !record(value.params) ||
        value.params.scope !== scope ||
        value.params.hostId !== "local" ||
        value.params.requestClient !== manager.requestClient ||
        !["readCreationInputs", "readPrewarmInputs", "readInputs"].every(
          (key) => typeof value[key] === "function",
        )
      )
        creationMissing.push("native creation-input reader ownership");
      else reader = value as unknown as CreationInputs;
    } catch {
      creationMissing.push("native creation-input reader initialization");
    }
  }
  const creationUnavailableReason = creationMissing.length
    ? `Schedule creation is unavailable in this window: ${creationMissing.join(", ")}. Reopen in the main Desktop window once its chat services are ready.`
    : null;
  const assertCreationAvailable = () => {
    assertAvailable();
    if (creationUnavailableReason)
      throw new DesktopScheduleRejectedError(creationUnavailableReason);
    if (!routing.forHost("local")?.policy.scopedCreation)
      throw new DesktopScheduleRejectedError(
        "Native scoped empty-chat/prewarm binding is no longer ready",
      );
  };
  return {
    creationUnavailableReason,
    assertAvailable,
    assertCreationAvailable,
    listAutomations: () => nativeResult(automations.list()),
    updateAutomation: (input) => nativeResult(automations.update(input)),
    deleteAutomation: (id) => nativeResult(automations.delete({ id })),
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
    allocate(title) {
      assertCreationAvailable();
      return manager.createProjectlessThreadWorkspace(title);
    },
    async validateDirectory(cwd) {
      const listing = await manager.sendRequest("fs/readDirectory", { path: cwd });
      if (!record(listing) || !Array.isArray(listing.entries))
        throw new Error("The working directory could not be verified");
    },
    createThread({ cwd, workspaceRoot, projectless, model, title }) {
      assertCreationAvailable();
      const currentRoute = routing.forHost("local");
      const creationReader = reader;
      if (!currentRoute || !creationReader)
        throw new DesktopScheduleRejectedError("Native empty-chat creation binding is unavailable");
      return currentRoute.policy.createScheduledConversation(
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
        (input: unknown, mode: unknown) => creationReader.readCreationInputs(input, mode),
      );
    },
    async inspectThread(threadId) {
      return threadInspectionSchema.parse(
        await manager.sendRequest("codexhost/thread/inspect", { threadId }),
      );
    },
    isThreadReady(threadId) {
      const conversation = manager.getConversation(threadId);
      const mode = record(conversation) ? conversation.latestCollaborationMode : null;
      // Only a newly registered, empty native chat is accepted here. The native
      // heartbeat observer owns subsequent eligibility and permission updates.
      return (
        record(conversation) &&
        conversation.resumeState === "resumed" &&
        conversation.mode === "default" &&
        conversation.ephemeral !== true &&
        conversation.sideConversation !== true &&
        record(conversation.currentPermissions) &&
        record(mode) &&
        record(mode.settings) &&
        typeof mode.settings.model === "string" &&
        mode.settings.model.length > 0 &&
        Array.isArray(conversation.turns) &&
        conversation.turns.length === 0 &&
        Array.isArray(conversation.requests) &&
        conversation.requests.length === 0 &&
        conversation.pendingRequest == null
      );
    },
    async save(input) {
      if (typeof automations.create !== "function")
        throw new DesktopScheduleRejectedError("Native localAutomations.create is unavailable");
      try {
        return await nativeResult(automations.create(input));
      } catch (error) {
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
      await scope.queryClient.invalidateQueries({ queryKey: ["vscode", "list-automations"] });
    },
  };
}
