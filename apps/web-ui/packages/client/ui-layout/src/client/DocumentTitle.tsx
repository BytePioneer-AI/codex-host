/** Keep the browser title independent of the active session or panel. */
import { useEffect } from "react";

/** Project the build-configured or localized product title into the browser tab. */
export function DocumentTitle({ productTitle }: { productTitle: string }): null {
  useEffect(() => {
    document.title = productTitle;
  }, [productTitle]);
  return null;
}
