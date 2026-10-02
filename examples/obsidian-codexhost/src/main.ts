import {
  FileSystemAdapter,
  ItemView,
  Modal,
  Notice,
  Plugin,
  WorkspaceLeaf,
} from "obsidian";
import {
  CodexHostClient,
  externalHarnessTransportModel,
} from "@codexhost/client";

const VIEW_TYPE_CODEXHOST = "codexhost-chat";

interface HarnessOption {
  id: string;
  name: string;
  model: string;
}

interface ChatMessage {
  role: "user" | "assistant" | "reasoning" | "tool" | "system";
  text: string;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

class ApprovalModal extends Modal {
  constructor(
    app: CodexHostBridgePlugin["app"],
    private readonly params: JsonObject,
    private readonly respond: (result: unknown) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const root = this.contentEl;
    root.empty();
    root.createEl("h3", { text: "Agent approval" });
    root.createEl("p", {
      text: typeof this.params.message === "string" ? this.params.message : "Allow this action?",
    });
    const meta = object(this.params._meta);
    if (typeof meta.reason === "string") root.createEl("pre", { text: meta.reason });

    const actions = root.createDiv({ cls: "codexhost-modal-actions" });
    const schema = object(this.params.requestedSchema);
    const properties = object(schema.properties);
    const actionId = object(properties.actionId);
    const choices = Array.isArray(actionId.oneOf) ? actionId.oneOf.map(object) : [];
    let selectedChoice = "";
    if (choices.length > 0) {
      const select = root.createEl("select");
      for (const choice of choices) {
        if (typeof choice.const !== "string") continue;
        select.createEl("option", {
          value: choice.const,
          text: typeof choice.title === "string" ? choice.title : choice.const,
        });
      }
      selectedChoice = select.value;
      select.addEventListener("change", () => (selectedChoice = select.value));
    }

    const deny = actions.createEl("button", { text: "Deny" });
    deny.addEventListener("click", () => {
      this.respond({ action: "decline", content: null });
      this.close();
    });
    const allow = actions.createEl("button", { text: "Allow" });
    allow.addClass("mod-cta");
    allow.addEventListener("click", () => {
      this.respond({
        action: "accept",
        content: selectedChoice ? { actionId: selectedChoice } : {},
      });
      this.close();
    });
  }
}

class QuestionModal extends Modal {
  constructor(
    app: CodexHostBridgePlugin["app"],
    private readonly params: JsonObject,
    private readonly respond: (result: unknown) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const root = this.contentEl;
    root.empty();
    root.createEl("h3", { text: "Agent question" });
    const questions = Array.isArray(this.params.questions) ? this.params.questions.map(object) : [];
    const answers = new Map<string, () => string[]>();

    for (const question of questions) {
      if (typeof question.id !== "string") continue;
      const section = root.createDiv({ cls: "codexhost-question" });
      section.createEl("div", {
        cls: "codexhost-question-title",
        text: typeof question.question === "string" ? question.question : question.id,
      });
      const options = Array.isArray(question.options) ? question.options.map(object) : null;
      if (options && options.length > 0) {
        const select = section.createEl("select");
        for (const option of options) {
          if (typeof option.label !== "string") continue;
          select.createEl("option", { value: option.label, text: option.label });
        }
        answers.set(question.id, () => (select.value ? [select.value] : []));
      } else {
        const input = section.createEl("input", { type: "text" });
        answers.set(question.id, () => (input.value.trim() ? [input.value.trim()] : []));
      }
    }

    const actions = root.createDiv({ cls: "codexhost-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.respond({ answers: {} });
      this.close();
    });
    const submit = actions.createEl("button", { text: "Submit" });
    submit.addClass("mod-cta");
    submit.addEventListener("click", () => {
      const result: Record<string, { answers: string[] }> = {};
      for (const [id, read] of answers) result[id] = { answers: read() };
      this.respond({ answers: result });
      this.close();
    });
  }
}

class CodexHostChatView extends ItemView {
  private client: CodexHostClient | null = null;
  private harnesses: HarnessOption[] = [];
  private selectedModel = "";
  private threadId: string | null = null;
  private turnId: string | null = null;
  private running = false;
  private sending = false;
  private messages: ChatMessage[] = [];
  private streamingText = "";
  private reasoningText = "";
  private itemTypes = new Map<string, string>();
  private toolOutputs = new Map<string, string>();

  private statusEl!: HTMLElement;
  private harnessEl!: HTMLSelectElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendEl!: HTMLButtonElement;
  private stopEl!: HTMLButtonElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: CodexHostBridgePlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CODEXHOST;
  }

  getDisplayText(): string {
    return "CodexHost";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    this.buildUi();
    await this.connect();
  }

  async onClose(): Promise<void> {
    this.disconnect();
  }

  private buildUi(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("codexhost-view");

    const toolbar = root.createDiv({ cls: "codexhost-toolbar" });
    this.statusEl = toolbar.createSpan({ text: "Disconnected" });
    this.harnessEl = toolbar.createEl("select");
    this.harnessEl.addEventListener("change", () => {
      this.selectedModel = this.harnessEl.value;
      this.threadId = null;
      this.turnId = null;
      this.streamingText = "";
      this.reasoningText = "";
      this.itemTypes.clear();
      this.toolOutputs.clear();
      this.messages = [];
      this.renderMessages();
    });

    const reconnect = toolbar.createEl("button", { text: "Reconnect" });
    reconnect.addEventListener("click", () => void this.connect());

    this.messagesEl = root.createDiv({ cls: "codexhost-messages" });
    const composer = root.createDiv({ cls: "codexhost-composer" });
    this.inputEl = composer.createEl("textarea");
    this.inputEl.placeholder = "Ask CodexHost...";

    this.inputEl.rows = 4;
    this.inputEl.addEventListener("keydown", (event) => {
      // Enter confirms IME text before it becomes a chat submission.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.send();
      }
    });

    const actions = composer.createDiv({ cls: "codexhost-actions" });
    this.sendEl = actions.createEl("button", { text: "Send" });
    this.sendEl.addEventListener("click", () => void this.send());
    this.stopEl = actions.createEl("button", { text: "Stop" });
    this.stopEl.disabled = true;
    this.stopEl.addEventListener("click", () => void this.stop());
  }

  private async connect(): Promise<void> {
    this.disconnect();
    this.setStatus("Connecting...");
    try {
      const client = await CodexHostClient.connect();
      client.on("notification", (method: string, params: unknown) => {
        this.handleNotification(method, params);
      });
      client.on("serverRequest", (
        id: string | number,
        method: string,
        params: unknown,
      ) => {
        this.handleServerRequest(id, method, params);
      });
      client.on("socketError", (error: Error) => {
        console.error("[codexhost]", error);
      });
      this.client = client;
      await this.loadHarnesses();
      this.setStatus(`Connected :${client.descriptor.port}`);
    } catch (error) {
      console.error("[codexhost] connect failed", error);
      this.client = null;
      this.setStatus("CodexHost unavailable");
    }
  }

  private disconnect(): void {
    this.client?.close();
    this.client = null;
    this.threadId = null;
    this.turnId = null;
    if (this.sendEl) this.setRunning(false);
    if (this.statusEl) this.setStatus("Disconnected");
  }

  private async loadHarnesses(): Promise<void> {
    if (!this.client) return;
    const pluginsResult = object(
      await this.client.request("codexhost/harness/plugins/list", {}),
    );
    const plugins = Array.isArray(pluginsResult.plugins)
      ? pluginsResult.plugins
      : [];

    const options: HarnessOption[] = [];
    try {
      const modelResult = object(await this.client.request("model/list", {}));
      const data = Array.isArray(modelResult.data) ? modelResult.data : [];
      const defaultModel = data
        .map(object)
        .find((entry) => entry.isDefault === true && typeof entry.model === "string");
      if (defaultModel && typeof defaultModel.model === "string") {
        options.push({
          id: "codex",
          name: "Codex",
          model: defaultModel.model,
        });
      }
    } catch (error) {
      console.warn("[codexhost] Codex model list unavailable", error);
    }

    for (const value of plugins) {
      const plugin = object(value);
      if (typeof plugin.id !== "string") continue;
      options.push({
        id: plugin.id,
        name: typeof plugin.name === "string" ? plugin.name : plugin.id,
        model: externalHarnessTransportModel(plugin.id),
      });
    }

    this.harnesses = options;
    this.harnessEl.empty();
    for (const option of options) {
      const element = this.harnessEl.createEl("option", {
        text: option.name,
        value: option.model,
      });
      element.dataset.harnessId = option.id;
    }
    this.selectedModel = options[0]?.model ?? "";
    this.sendEl.disabled = options.length === 0;
  }

  private vaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    throw new Error("CodexHost requires a local filesystem Vault");
  }

  private async ensureThread(): Promise<string> {
    if (this.threadId) return this.threadId;
    if (!this.client) throw new Error("CodexHost is not connected");
    if (!this.selectedModel) throw new Error("No Harness is selected");

    const result = object(
      await this.client.request("thread/start", {
        model: this.selectedModel,
        cwd: this.vaultPath(),
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      }),
    );
    const thread = object(result.thread);
    if (typeof thread.id !== "string") {
      throw new Error("thread/start did not return a Thread ID");
    }
    this.threadId = thread.id;
    return thread.id;
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || !this.client || this.sending || this.running) return;

    this.sending = true;
    this.inputEl.value = "";
    this.messages.push({ role: "user", text });
    this.streamingText = "";
    this.reasoningText = "";
    this.itemTypes.clear();
    this.toolOutputs.clear();
    this.renderMessages();
    this.setRunning(true);

    try {
      const threadId = await this.ensureThread();
      const result = object(
        await this.client.request("turn/start", {
          threadId,
          input: [{ type: "text", text }],
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "workspaceWrite" },
        }),
      );
      const turn = object(result.turn);
      // Completion notifications can arrive before the request response.
      if (this.running && typeof turn.id === "string") this.turnId = turn.id;
    } catch (error) {
      this.messages.push({
        role: "system",
        text: error instanceof Error ? error.message : String(error),
      });
      this.setRunning(false);
      this.renderMessages();
    } finally {
      this.sending = false;
    }
  }

  private async stop(): Promise<void> {
    if (!this.client || !this.threadId || !this.turnId) return;
    try {
      await this.client.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.turnId,
      });
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private handleServerRequest(
    id: string | number,
    method: string,
    rawParams: unknown,
  ): void {
    if (!this.client) return;
    const params = object(rawParams);
    if (method === "mcpServer/elicitation/request") {
      new ApprovalModal(this.app, params, (result) => {
        this.client?.respond(id, result);
      }).open();
      return;
    }
    if (method === "item/tool/requestUserInput") {
      new QuestionModal(this.app, params, (result) => {
        this.client?.respond(id, result);
      }).open();
      return;
    }
    this.client.respondError(id, -32001, `Unsupported UI interaction: ${method}`);
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = object(rawParams);
    if (this.threadId && params.threadId && params.threadId !== this.threadId) return;

    if (method === "turn/started") {
      const turn = object(params.turn);
      if (typeof turn.id === "string") this.turnId = turn.id;
      this.setRunning(true);
      return;
    }

    if (method === "item/started") {
      const item = object(params.item);
      if (typeof item.id === "string" && typeof item.type === "string") {
        this.itemTypes.set(item.id, item.type);
        if (item.type === "commandExecution" && item.command === "thinking") {
          this.itemTypes.set(item.id, "reasoningTranscript");
        }
      }
      return;
    }

    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.streamingText += params.delta;
      this.renderMessages();
      return;
    }

    if (method === "item/reasoning/summaryTextDelta" && typeof params.delta === "string") {
      this.reasoningText += params.delta;
      this.renderMessages();
      return;
    }

    if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
      const itemId = typeof params.itemId === "string" ? params.itemId : "tool";
      if (this.itemTypes.get(itemId) !== "reasoningTranscript") {
        this.toolOutputs.set(itemId, (this.toolOutputs.get(itemId) ?? "") + params.delta);
        this.renderMessages();
      }
      return;
    }

    if (method === "item/completed") {
      const item = object(params.item);
      if (item.type === "agentMessage" && typeof item.text === "string" && !this.streamingText) {
        this.streamingText = item.text;
        this.renderMessages();
      }
      return;
    }

    if (method === "turn/completed") {
      if (this.reasoningText) this.messages.push({ role: "reasoning", text: this.reasoningText });
      for (const output of this.toolOutputs.values()) {
        if (output.trim()) this.messages.push({ role: "tool", text: output });
      }
      if (this.streamingText) this.messages.push({ role: "assistant", text: this.streamingText });
      this.streamingText = "";
      this.reasoningText = "";
      this.itemTypes.clear();
      this.toolOutputs.clear();
      this.turnId = null;
      this.setRunning(false);
      this.renderMessages();
      return;
    }

    if (method === "error") {
      const error = object(params.error);
      const message = typeof error.message === "string" ? error.message : "Agent error";
      this.messages.push({ role: "system", text: message });
      this.renderMessages();
    }
  }

  private setRunning(running: boolean): void {
    this.running = running;
    this.sendEl.disabled = running || !this.selectedModel;
    this.stopEl.disabled = !running;
    this.harnessEl.disabled = running;
  }

  private setStatus(text: string): void {
    this.statusEl.setText(text);
  }

  private renderMessages(): void {
    this.messagesEl.empty();
    for (const message of this.messages) {
      this.renderMessage(message);
    }
    if (this.reasoningText) {
      this.renderMessage({ role: "reasoning", text: this.reasoningText });
    }
    for (const output of this.toolOutputs.values()) {
      if (output.trim()) this.renderMessage({ role: "tool", text: output });
    }
    if (this.streamingText) {
      this.renderMessage({ role: "assistant", text: this.streamingText });
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderMessage(message: ChatMessage): void {
    const card = this.messagesEl.createDiv({
      cls: `codexhost-message codexhost-${message.role}`,
    });
    card.createDiv({
      cls: "codexhost-message-role",
      text: message.role,
    });
    card.createDiv({
      cls: "codexhost-message-text",
      text: message.text,
    });
  }
}

export default class CodexHostBridgePlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(
      VIEW_TYPE_CODEXHOST,
      (leaf) => new CodexHostChatView(leaf, this),
    );

    this.addRibbonIcon("bot", "Open CodexHost", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "codexhost-open-chat",
      name: "Open CodexHost chat",
      callback: () => void this.activateView(),
    });
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CODEXHOST);
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEXHOST)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) {
      await leaf.setViewState({
        type: VIEW_TYPE_CODEXHOST,
        active: true,
      });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
}
