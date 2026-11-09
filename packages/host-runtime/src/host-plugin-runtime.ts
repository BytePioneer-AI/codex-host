import { Context, type Plugin } from "@deepseek-ai/cordis";

/** One runtime per owner, not a process singleton. Business contracts stay outside Cordis. */
export class HostPluginRuntime {
  readonly #context = new Context();
  #closing: Promise<void> | undefined;

  async mount(plugin: Plugin): Promise<void> {
    if (this.#closing) throw new Error("Plugin runtime is closed");
    const fiber = this.#context.plugin(plugin);
    try {
      await fiber;
    } catch (error) {
      await fiber.dispose();
      throw error;
    }
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#context.fiber.dispose());
  }
}
