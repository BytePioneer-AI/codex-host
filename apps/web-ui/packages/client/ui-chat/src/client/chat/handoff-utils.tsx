import {
  harnessIconSources,
  IconDataOutlineRegular,
  RemotePluginIcon,
} from "@deepseek-ai/dsh-client-ui-primitives";

/** Clean internal routing prefixes and service-tier separators from a model or Harness display label. */
export function formatHandoffEndpointLabel(input: {
  harnessId: string;
  harnessLabel?: string | undefined;
  model?: string | undefined;
}): { readonly display: string; readonly title: string } {
  const harnessName = input.harnessLabel?.trim() || input.harnessId;
  const cleanedModel = sanitizeHandoffModelLabel(input.model, input.harnessId);
  if (cleanedModel === undefined) {
    return { display: harnessName, title: harnessName };
  }
  const title =
    cleanedModel.toLowerCase() === harnessName.toLowerCase()
      ? cleanedModel
      : `${harnessName} · ${cleanedModel}`;
  return { display: cleanedModel, title };
}

function sanitizeHandoffModelLabel(
  rawModel: string | undefined,
  harnessId: string,
): string | undefined {
  if (rawModel === undefined) return undefined;
  let value = rawModel.trim();
  if (value === "") return undefined;
  // Strip service-tier separator encoded by harnessModelRefKey (e.g. `model\u001fpriority`).
  const tierSeparator = value.indexOf("\u001f");
  if (tierSeparator !== -1) value = value.slice(0, tierSeparator).trim();
  // Strip internal CodexHost transport/route prefixes (e.g. `codexhost/harness/claude-code/model`).
  value = value.replace(/^codexhost[:/]+/iu, "");
  value = value.replace(/^(?:harness|external|route)\/+/iu, "");
  const escapedHarness = harnessId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  value = value.replace(new RegExp(`^${escapedHarness}[:/]+`, "iu"), "");
  value = value.trim();
  if (value === "" || value.toLowerCase() === "harness") return undefined;
  return value;
}

/** Opposing horizontal arrows glyph (`⇄`) used for context handoff controls and dividers. */
export function HandoffSwapIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 5.25H13.25" />
      <path d="M10.5 2.75L13.25 5.25L10.5 7.75" />
      <path d="M13.5 10.75H2.75" />
      <path d="M5.5 8.25L2.75 10.75L5.5 13.25" />
    </svg>
  );
}

/** Harness icon rendered from local/remote plugin assets with native Codex handling. */
export function HandoffHarnessIcon({
  harnessId,
  label,
  hostId,
  size = 15,
  className,
}: {
  harnessId: string;
  label?: string | undefined;
  hostId?: string | undefined;
  size?: number;
  className?: string;
}) {
  const icon = harnessIconSources(harnessId, hostId);
  return (
    <span
      className={className}
      data-harness-id={harnessId}
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      {harnessId === "codex" ? (
        <img
          src={icon.src}
          width={size}
          height={size}
          alt={label ?? ""}
          style={{ display: "block", width: size, height: size, objectFit: "contain" }}
        />
      ) : (
        <RemotePluginIcon
          id={harnessId}
          src={icon.src}
          presentationUrl={icon.presentationUrl}
          size={size}
          fallback={<IconDataOutlineRegular size={size} />}
        />
      )}
    </span>
  );
}
