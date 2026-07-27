# Renderer Agent Binding Probe

This diagnostic probe tests whether codexhost can inject a browser-safe `Codex / Pi` selector into the official Codex Composer and capture the selected Agent at DOM submission time.

## Scope

The probe:

- starts or attaches to Codex Desktop through loopback CDP and the Electron main-process Inspector;
- uses the public Electron `webContents` API to locate the populated Renderer when the production window has `devTools: false`;
- keeps Agent selection isolated by Composer and emits sanitized submission observations;
- records structural counts, tag names, attribute names, generated probe IDs, and binding status only.

The probe does not read or persist Prompt text, input values, complete DOM payloads, page titles, URL query/hash values, or screenshots. Reports and logs are written under the ignored `.codexhost/renderer-binding/` directory.

## Current Result

A controlled Windows test against Codex Desktop `26.721.4979.0` confirmed that:

- direct CDP exposes only the outer `app://-/index.html` page;
- the Electron main-process Inspector can inject the selector into the populated Renderer;
- the selector mounts beside the native Composer controls;
- an Enter submission can retain and report a Composer-scoped `pi` selection.

Creation binding remains `BLOCKED`. The probe neither controls the Host creation boundary nor modifies the native Model state. This result must not be interpreted as Pi routing or as permission to silently fall back to Codex.

A controlled Windows test then launched Desktop through the codexhost Shim and a Host route observer with the process default fixed to Codex. One submission produced a Renderer observation with `agent: "pi"`, while both real `thread/start` requests observed during that interaction were classified as `official-model` and selected Codex. The visible response also came from Codex. This proves the independent selector does not currently set `thread/start.params.model` to `codexhost/pi-native`.

The combined test also exposed and fixed a Windows Shim launch defect: canonical Host Runtime paths use the `\\?\` verbatim prefix, which Node.js cannot consume as its entrypoint argument. The Shim now passes a normalized Win32 path to Node after canonical validation.

The controlled interaction did not exercise rapid concurrent creation, retry, Renderer reload, or a live DOM-root replacement. Registry replacement transfer has unit coverage, but its Renderer mutation path remains a residual live-test gap.

## Run

Build the workspace, then attach to existing loopback endpoints:

```text
npm run probe:renderer-binding -- --endpoint http://127.0.0.1:9222 --inspector-endpoint http://127.0.0.1:9223
```

To start a controlled Desktop instance, also pass an absolute `--desktop` executable path. Use `--until-submissions <count>` for an interaction run that completes after a fixed number of sanitized observations.
