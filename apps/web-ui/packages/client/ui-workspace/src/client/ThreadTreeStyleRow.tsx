/** General → Display row for the browser-local tree style. */
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { WorkspacePreferences, ThreadTreeCollapseStyle } from "./workspace-preferences.ts";
import { ThreadTreeStyleOptions } from "./ThreadTreeStyleOptions.tsx";

export interface ThreadTreeStyleRowInjected {
  hooks: { preference: HostObservable<ConfigFormSnapshot<WorkspacePreferences>> };
  setStyle: (style: ThreadTreeCollapseStyle) => Promise<boolean>;
}
export function ThreadTreeStyleRow({
  usePreference,
  setStyle,
  t,
}: PropsRuntime<"settings.general.item"> &
  PropsLocale<"workspace"> &
  InjectFace<ThreadTreeStyleRowInjected>) {
  const style = usePreference((snapshot) => snapshot.value?.threadTreeCollapseStyle ?? "summary");
  return <ThreadTreeStyleOptions style={style} setStyle={setStyle} t={t} settings />;
}
