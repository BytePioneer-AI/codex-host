/** One composer seat with separate model/effort and native Harness controls. */
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { ModelSelectInjected } from "./slots.ts";
import { HarnessSelect } from "./HarnessSelect.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import css from "./HarnessSelect.module.css";

/** Share the existing per-session directory instead of introducing a second selected Harness state. */
export function ModelControls(
  props: ModelSelectInjected & { locked: boolean } & PropsLocale<"model">,
) {
  return (
    <div className={css.controls}>
      <ModelSelect {...props} />
      <HarnessSelect {...props} />
    </div>
  );
}
