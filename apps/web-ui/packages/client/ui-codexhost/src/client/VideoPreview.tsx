/** Workspace video playback through the authenticated Web gateway. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { DocumentPreviewProps } from "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { parseFileAddress, pathPartsOf } from "@deepseek-ai/dsh-util-workspace-path";
import type {} from "@deepseek-ai/dsh-api-workspace-files/remote";
import type {} from "./index.ts";
import css from "./VideoPreview.module.css";

const VIDEO_PREVIEW_ID = "@deepseek-ai/dsh-client-ui-codexhost/video";
const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm", "ogv"];

interface VideoSource {
  readonly url: string;
  readonly version: string;
}

interface VideoInjected {
  readonly source: (address: string, revision: number, signal: AbortSignal) => Promise<VideoSource>;
}

type VideoProps = DocumentPreviewProps & PropsLocale<"codexhostImport"> & VideoInjected;

/** Register a streaming renderer without imposing the full-file document read limit. */
export function registerVideoPreview(ctx: Context): void {
  ctx.inject(["documentPreviews", "remote.workspaceFiles"], (scope) => {
    const t = scope.locale.bind("codexhostImport");
    scope.effect(() =>
      scope.documentPreviews.register({
        id: VIDEO_PREVIEW_ID,
        extensions: VIDEO_EXTENSIONS,
        binaryExtensions: VIDEO_EXTENSIONS,
        priority: "builtin",
        title: () => t("video.title"),
        loading: "renderer",
        wrap: false,
      }),
    );
    scope.effect(() =>
      scope.slots.inject("sidebar.right.tab.document", () =>
        scope.slots.register(
          {
            name: "sidebar.right.tab.document",
            key: VIDEO_PREVIEW_ID,
            locale: "codexhostImport",
            inject: (): VideoInjected => ({
              source: async (address, revision, signal) => {
                const file = parseFileAddress(address);
                if (file?.scope !== "session") throw new Error("A Session file is required");
                const meta = await scope.remote.workspaceFiles.stat(
                  file.sessionId as SessionId,
                  file.path,
                  signal,
                );
                if (!meta.ok) throw new Error(meta.error.message);
                const query = new URLSearchParams({
                  sessionId: file.sessionId,
                  path: file.path,
                  revision: String(revision),
                });
                return { url: `/api/workspace-file/video?${query}`, version: meta.value.version };
              },
            }),
          },
          VideoPreview,
        ),
      ),
    );
  });
}

function VideoPreview(props: VideoProps): ReactNode {
  if (props.content.kind !== "renderer") return null;
  return (
    <VideoPlayer
      key={`${props.resourceAddress}:${props.content.revision}`}
      {...props}
      request={props.content}
    />
  );
}

/** Each revision owns its media element; unmounting releases playback and in-flight reads. */
function VideoPlayer({
  resourceAddress,
  source,
  request,
  t,
}: VideoProps & {
  readonly request: Extract<DocumentPreviewProps["content"], { kind: "renderer" }>;
}): ReactNode {
  const [media, setMedia] = useState<VideoSource>();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const player = useRef<HTMLVideoElement>(null);
  const settled = useRef(request);
  settled.current = request;
  useEffect(() => {
    const controller = new AbortController();
    void source(resourceAddress, request.revision, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setMedia(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState("failed");
          settled.current.failed();
        }
      });
    return () => controller.abort();
  }, [resourceAddress, source, request.revision]);
  useEffect(() => {
    const video = player.current;
    return () => {
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [media]);
  const path = parseFileAddress(resourceAddress)?.path ?? "";
  return (
    <div className={css.preview} data-video-preview>
      {state === "loading" && (
        <p className={css.status} role="status">
          {t("video.loading")}
        </p>
      )}
      {state === "failed" ? (
        <div className={css.failure}>
          <p className={css.status} role="alert">
            {t("video.failed")}
          </p>
          <Button variant="outline" size="sm" onClick={request.reload}>
            {t("video.retry")}
          </Button>
        </div>
      ) : (
        media && (
          <video
            ref={player}
            className={css.player}
            src={media.url}
            controls
            playsInline
            preload="metadata"
            aria-label={t("video.preview", { name: pathPartsOf(path).name })}
            onLoadedMetadata={() => {
              setState("ready");
              settled.current.loaded(media.version);
            }}
            onError={() => {
              setState("failed");
              settled.current.failed();
            }}
          />
        )
      )}
    </div>
  );
}
