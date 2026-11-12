// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { WebUiExtensionsState } from "@codexhost/shared-contracts";
import { WebExtensionsSection } from "../../apps/web-ui/packages/client/ui-codexhost/src/client/WebExtensionsSection.tsx";
import { ApiError } from "../../apps/web-ui/packages/client/ui-codexhost/src/client/api.ts";
import { uiExtensionsApi } from "../../apps/web-ui/packages/client/ui-codexhost/src/client/ui-extensions-api.ts";
import { formatWebExtensionError } from "../../apps/web-ui/packages/client/ui-codexhost/src/client/web-extension-errors.ts";
import {
  en,
  zh,
  type ImportLocaleKey,
} from "../../apps/web-ui/packages/client/ui-codexhost/src/client/locales.ts";

vi.mock("../../apps/web-ui/packages/client/ui-codexhost/src/client/ui-extensions-api.ts", () => ({
  uiExtensionsApi: {
    list: vi.fn(),
    install: vi.fn(),
    setEnabled: vi.fn(),
    remove: vi.fn(),
  },
}));

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function state(enabled = false): WebUiExtensionsState {
  return {
    extensions: [
      {
        id: "test-theme",
        name: "Test Theme",
        version: "1.2.3",
        format: "dsh",
        supportedTargets: ["web"],
        enabledTargets: enabled ? ["web"] : [],
        source: "test-theme@1.2.3",
        installedAt: "2026-11-04T00:00:00.000Z",
      },
    ],
    loadedIds: [],
    safeMode: false,
  };
}

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const props = {
    t: (key: keyof typeof en, args: Record<string, string> = {}) =>
      en[key].replace(/\{(\w+)\}/gu, (_match, name: string) => args[name] ?? ""),
  } as unknown as ComponentProps<typeof WebExtensionsSection>;
  await act(async () => root.render(createElement(WebExtensionsSection, props)));
  const button = (label: string): HTMLButtonElement => {
    const match = [...document.querySelectorAll("button")].find(
      (entry) => entry.textContent === label || entry.getAttribute("aria-label") === label,
    );
    if (match === undefined) throw new Error(`Missing button: ${label}`);
    return match;
  };
  return { container, button };
}

async function setInput(label: string, value: string): Promise<HTMLInputElement> {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

async function selectRegistry(value: string): Promise<void> {
  await act(async () => {
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Installation source"]',
    )!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("shows local-access guidance instead of installation controls", async () => {
  vi.mocked(uiExtensionsApi.list).mockRejectedValue(
    new ApiError("Local access required", "auth/local-access-required", {
      url: "http://127.0.0.1:4400",
    }),
  );
  const { container } = await mount();
  expect(
    container.querySelector('[data-web-extensions-notice="non-local"]')?.textContent,
  ).toContain("http://127.0.0.1:4400");
  expect(container.querySelector("form")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
});

it("keeps saved enablement distinct from current server loading and confirms removal", async () => {
  vi.mocked(uiExtensionsApi.list).mockResolvedValue(state());
  vi.mocked(uiExtensionsApi.setEnabled).mockResolvedValue(state(true));
  vi.mocked(uiExtensionsApi.remove).mockResolvedValue({
    extensions: [],
    loadedIds: [],
    safeMode: false,
  });
  const { container, button } = await mount();
  expect(container.textContent).toContain("Disabled");
  const toggle = container.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Test Theme"]',
  )!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => toggle.click());
  expect(uiExtensionsApi.setEnabled).toHaveBeenCalledExactlyOnceWith("test-theme", true);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("Enabled for Web");
  expect(container.textContent).toContain("The saved selection is not loaded on the server.");
  await act(async () => button("Test Theme").click());
  expect(container.querySelector('[data-web-extension-detail="test-theme"]')).not.toBeNull();
  expect(container.textContent).not.toContain(
    "Loaded on the server; connected ordinary pages synchronize automatically.",
  );
  await act(async () => button("Uninstall").click());
  expect(uiExtensionsApi.remove).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Uninstall “Test Theme”?");
  await act(async () => button("Uninstall").click());
  expect(uiExtensionsApi.remove).toHaveBeenCalledExactlyOnceWith("test-theme");
  expect(container.textContent).toContain("No interface extensions installed.");
});

function locale(dict: Record<ImportLocaleKey, string>) {
  return (key: ImportLocaleKey, args: Record<string, unknown> = {}) =>
    dict[key].replace(/\{(\w+)\}/gu, (_match, name: string) => String(args[name] ?? ""));
}

it("explains a missing Host module instead of an unknown version", () => {
  const message =
    "web-assets: @changfenhuang/dsh-genui requires @deepseek-ai/dsh-agent@^0.2.0-rc.1 || ^0.2.1-rc.1 || ^0.2.2-alpha.2, but the browser Host does not provide @deepseek-ai/dsh-agent";
  expect(formatWebExtensionError(message, locale(en))).toBe(
    "This Web cannot install this extension. It only supports themes, sidebar panels, and display components.",
  );
  expect(formatWebExtensionError(message, locale(zh))).toBe(
    "当前 Web 不支持这个扩展。这里只能安装主题、侧栏和展示组件。",
  );
  expect(
    formatWebExtensionError(
      "web-assets: addon requires react@^19.0.0, but the browser Host provides 18.3.1",
      locale(en),
    ),
  ).toBe("This extension does not match this Web version, so it cannot be installed.");
  expect(
    formatWebExtensionError(
      "web-assets: addon requires unavailable browser module react",
      locale(zh),
    ),
  ).toBe("当前 Web 不支持这个扩展。这里只能安装主题、侧栏和展示组件。");
  expect(formatWebExtensionError("web-assets: addon declares no web client", locale(en))).toBe(
    "addon declares no web client",
  );
});

it("keeps installation failures visible and preserves the source for retry", async () => {
  vi.mocked(uiExtensionsApi.list).mockResolvedValue({
    extensions: [],
    loadedIds: [],
    safeMode: false,
  });
  vi.mocked(uiExtensionsApi.install).mockRejectedValue(
    new Error("Package requires a backend service"),
  );
  const { container, button } = await mount();
  await act(async () => button("Add extension").click());
  const input = await setInput("Package name or address", "test-theme");
  await act(async () => button("Install").click());
  expect(uiExtensionsApi.install).toHaveBeenCalledExactlyOnceWith(
    "test-theme",
    "https://registry.npmjs.org/",
  );
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
    "That did not work: Package requires a backend service",
  );
  expect(input.value).toBe("test-theme");
  expect(button("Install").disabled).toBe(false);
  expect(container.querySelector('a[href="/extensions"]')).not.toBeNull();
  expect(container.querySelector('a[href="/?extensions=off"]')).not.toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => button("Add extension").click());
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Package name or address"]')?.value,
  ).toBe("test-theme");
});

it("shows a missing Host module as an incompatible-extension failure", async () => {
  vi.mocked(uiExtensionsApi.list).mockResolvedValue({
    extensions: [],
    loadedIds: [],
    safeMode: false,
  });
  vi.mocked(uiExtensionsApi.install).mockRejectedValue(
    new Error(
      "web-assets: @changfenhuang/dsh-genui requires @deepseek-ai/dsh-agent@^0.2.0-rc.1 || ^0.2.1-rc.1 || ^0.2.2-alpha.2, but the browser Host does not provide @deepseek-ai/dsh-agent",
    ),
  );
  const { button } = await mount();
  await act(async () => button("Add extension").click());
  await setInput("Package name or address", "@changfenhuang/dsh-genui");
  await act(async () => button("Install").click());
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
    "That did not work: This Web cannot install this extension. It only supports themes, sidebar panels, and display components.",
  );
});

it.each([
  ["test-theme", "official", "https://registry.npmjs.org/"],
  ["https://github.com/owner/theme#v1", "mirror", "https://registry.npmmirror.com/"],
  ["/absolute/path/to/theme", "custom", "https://registry.example.test/plugins/"],
])("installs %s from the selected registry and closes the dialog", async (spec, registry, url) => {
  vi.mocked(uiExtensionsApi.list).mockResolvedValue({
    extensions: [],
    loadedIds: [],
    safeMode: false,
  });
  vi.mocked(uiExtensionsApi.install).mockResolvedValue(state());
  const { container, button } = await mount();
  await act(async () => button("Add extension").click());
  expect(button("Install").disabled).toBe(true);
  await setInput("Package name or address", spec);
  await selectRegistry(registry);
  if (registry === "custom") await setInput("Custom registry URL", url.replace(/\/$/u, ""));
  await act(async () => button("Install").click());
  expect(uiExtensionsApi.install).toHaveBeenCalledExactlyOnceWith(spec, url);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("Test Theme");
  expect(container.textContent).toContain("Disabled");
  await act(async () => button("Add extension").click());
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Package name or address"]')?.value,
  ).toBe("");
  expect(
    document.querySelector<HTMLSelectElement>('select[aria-label="Installation source"]')?.value,
  ).toBe(registry);
});

it("rejects an invalid custom registry before sending an installation request", async () => {
  vi.mocked(uiExtensionsApi.list).mockResolvedValue(state());
  const { button } = await mount();
  await act(async () => button("Add extension").click());
  await setInput("Package name or address", "test-theme");
  await selectRegistry("custom");
  await setInput("Custom registry URL", "https://username:secret@example.test/");
  await act(async () => button("Install").click());
  expect(uiExtensionsApi.install).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("without a username");
  expect(
    document.querySelector('input[aria-label="Custom registry URL"]')?.getAttribute("aria-invalid"),
  ).toBe("true");
});

it("keeps the pending installation visible and prevents another submission", async () => {
  vi.mocked(uiExtensionsApi.list).mockResolvedValue(state());
  let complete!: (value: WebUiExtensionsState) => void;
  vi.mocked(uiExtensionsApi.install).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const { button } = await mount();
  await act(async () => button("Add extension").click());
  await setInput("Package name or address", "test-theme");
  await act(async () => button("Install").click());
  expect(button("Installing…").disabled).toBe(true);
  await act(async () => button("Close").click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(uiExtensionsApi.install).toHaveBeenCalledTimes(1);
  await act(async () => complete(state()));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("preserves enabled choices in safe mode and prevents writes when saved records cannot be read", async () => {
  vi.mocked(uiExtensionsApi.list).mockResolvedValue({
    ...state(true),
    safeMode: true,
    storeError: "Invalid extension records",
  });
  const { container, button } = await mount();
  expect(container.textContent).toContain("Your saved choices are kept.");
  expect(container.textContent).toContain("Enabled for Web");
  expect(container.textContent).not.toContain("The saved selection is not loaded on the server.");
  const toggle = container.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Test Theme"]',
  )!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(toggle.disabled).toBe(true);
  expect(button("Add extension").disabled).toBe(true);
  expect(button("Refresh list").disabled).toBe(false);
  await act(async () => button("Test Theme").click());
  expect(container.querySelector('[data-web-extension-detail="test-theme"]')).not.toBeNull();
  const detailToggle = container.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Test Theme"]',
  )!;
  expect(detailToggle.getAttribute("aria-checked")).toBe("true");
  expect(detailToggle.disabled).toBe(true);
  expect(button("Uninstall").disabled).toBe(true);
});

it("sends installation requests through the shared RPC envelope and validates returned state", async () => {
  const { uiExtensionsApi: api } = await vi.importActual<
    typeof import("../../apps/web-ui/packages/client/ui-codexhost/src/client/ui-extensions-api.ts")
  >("../../apps/web-ui/packages/client/ui-codexhost/src/client/ui-extensions-api.ts");
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ result: { ok: true, value: state() } })));
  vi.stubGlobal("fetch", fetchMock);
  expect(await api.install("test-theme", "https://registry.npmmirror.com/")).toEqual(state());
  const [url, request] = fetchMock.mock.calls[0]!;
  expect(url).toBe("api/codexhost/uiExtensions/install");
  expect(request).toMatchObject({ method: "POST", credentials: "same-origin" });
  expect(JSON.parse(request.body)).toEqual({
    type: "client-request",
    rpcId: expect.any(String),
    method: "codexhost/uiExtensions/install",
    payload: { args: { spec: "test-theme", registry: "https://registry.npmmirror.com/" } },
  });
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ result: { ok: true, value: {} } })));
  await expect(api.list()).rejects.toThrow();
});

it("preserves local-access error details even when the RPC returns HTTP 403", async () => {
  const { uiExtensionsApi: api } = await vi.importActual<
    typeof import("../../apps/web-ui/packages/client/ui-codexhost/src/client/ui-extensions-api.ts")
  >("../../apps/web-ui/packages/client/ui-codexhost/src/client/ui-extensions-api.ts");
  const error = {
    message: "Local access required",
    code: "auth/local-access-required",
    details: { url: "http://127.0.0.1:4400" },
  };
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { ok: false, error } }), { status: 403 }),
      ),
  );
  await expect(api.list()).rejects.toMatchObject(error);
});
