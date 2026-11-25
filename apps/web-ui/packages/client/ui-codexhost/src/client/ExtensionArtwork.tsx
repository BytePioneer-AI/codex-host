import { useState } from "react";
import { IconCordisPluginOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./WebExtensionsSection.module.css";

/** Package SVGs stay in image context; undecodable artwork uses the default plugin icon. */
export function ExtensionArtwork({ src }: { src: string | undefined }) {
  const [failed, setFailed] = useState<string>();
  return (
    <span className={css.artwork} aria-hidden="true">
      {src !== undefined && src !== failed ? (
        <img
          src={src}
          width={32}
          height={32}
          alt=""
          className={css.packageImage}
          data-extension-icon
          onError={() => setFailed(src)}
        />
      ) : (
        <IconCordisPluginOutlineRegular size={26} />
      )}
    </span>
  );
}
