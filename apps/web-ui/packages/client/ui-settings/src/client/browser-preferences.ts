/** Per-browser UI preferences; other namespaces retain their Host-owned storage. */
import type {
  SettingsNamespaceView,
  SettingsPathOpView,
} from "@deepseek-ai/dsh-api-remotes/client";
import type { SettingsSchemaService } from "./schema.ts";

const NAMESPACES = new Set([
  "ui-theme",
  "locale",
  "ui-chat",
  "ui-conversation",
  "ui-settings",
  "ui-workspace",
]);

export function isBrowserPreference(namespace: string): boolean {
  return NAMESPACES.has(namespace);
}

interface SavedPreferences {
  user: Record<string, unknown>;
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class BrowserPreferences {
  readonly key: string;

  constructor(
    namespace: string,
    private readonly schema: SettingsSchemaService,
  ) {
    this.key = `codexhost.web.preferences.v1:${namespace}`;
  }

  /** Seed once from existing preferences; subsequent Host changes do not replace local choices. */
  read(view: SettingsNamespaceView): SettingsNamespaceView {
    let saved: SavedPreferences | undefined;
    try {
      const candidate: unknown = JSON.parse(localStorage.getItem(this.key) ?? "null");
      if (
        isRecord(candidate) &&
        isRecord(candidate.user) &&
        Number.isSafeInteger(candidate.revision) &&
        (candidate.revision as number) >= 0 &&
        this.valid(view, candidate.user)
      ) {
        saved = candidate as unknown as SavedPreferences;
      }
    } catch {
      // Unavailable storage or malformed data must not prevent opening settings.
    }
    if (saved === undefined) {
      saved = { user: isRecord(view.user) ? view.user : {}, revision: 0 };
      if (!this.valid(view, saved.user)) saved.user = {};
      this.save(saved);
    }
    return {
      ...view,
      ...saved,
      value: { ...(isRecord(view.base) ? view.base : {}), ...saved.user },
    };
  }

  /** Apply UI field edits to the latest browser record without writing to the Host. */
  write(
    view: SettingsNamespaceView,
    ops: readonly SettingsPathOpView[],
    expectedRevision?: number,
  ): boolean {
    const current = this.read(view);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) return false;
    let user = { ...(isRecord(current.user) ? current.user : {}) };
    for (const op of ops) {
      // These UI namespaces contain scalar fields only.
      if (op.path.length !== 1) return false;
      const field = op.path[0] as string;
      if (op.op === "set") user = { ...user, [field]: op.value };
      else delete user[field];
    }
    if (!this.valid(view, user)) return false;
    return this.save({ user, revision: current.revision + 1 });
  }

  private valid(view: SettingsNamespaceView, user: Record<string, unknown>): boolean {
    try {
      return (
        this.schema.validate(this.schema.rehydrate(view.schema), {
          ...(isRecord(view.base) ? view.base : {}),
          ...user,
        }) === undefined
      );
    } catch {
      return false;
    }
  }

  private save(saved: SavedPreferences): boolean {
    try {
      localStorage.setItem(this.key, JSON.stringify(saved));
      return true;
    } catch {
      return false;
    }
  }
}
