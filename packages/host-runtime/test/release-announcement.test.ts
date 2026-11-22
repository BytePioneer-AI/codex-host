import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RELEASE_ANNOUNCEMENT_ACKNOWLEDGE_METHOD as ACKNOWLEDGE,
  RELEASE_ANNOUNCEMENT_GET_METHOD as GET,
  releaseAnnouncementGetResultSchema,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { HostReleaseAnnouncement } from "../src/release-announcement.js";
import { closeFixture, createFixture, requestId, writeRequest } from "./app-server-host-fixture.js";

const version = "0.24.0";
const noAnnouncement = { result: { announcement: null, unread: false } };
const acknowledged = { result: { acknowledged: true } };
const release = () =>
  Response.json({
    tag_name: `v${version}`,
    html_url: `https://github.com/BytePioneer-AI/codex-host/releases/tag/v${version}`,
    published_at: "2026-11-22T00:00:00Z",
    draft: false,
    prerelease: false,
    body: "本次更新\n\n### 🧩 插件两端通用\nDesktop 和 Web 共用一套插件。\n— @BytePioneer-AI",
  });

let directory: string;
let fixture: ReturnType<typeof createFixture> | undefined;
const github = vi.fn(async () => release());

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codexhost-release-announcement-"));
  github.mockReset().mockImplementation(async () => release());
  vi.stubGlobal("fetch", github);
});

afterEach(async () => {
  try {
    if (fixture) await closeFixture(fixture);
  } finally {
    fixture = undefined;
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});

function startHost(externalOnly = true) {
  const environment = { CODEXHOST_DATA_DIR: directory, CODEXHOST_DEV_VERSION: version };
  fixture = createFixture({
    externalOnly,
    mappingStoreDirectory: directory,
    environment,
    releaseAnnouncement: new HostReleaseAnnouncement(
      resolve("packages/host-runtime/dist/main.js"),
      environment,
    ),
  });
  return fixture;
}

test("persists a Desktop acknowledgement, skips automatic Web fetches, and allows manual reads", async () => {
  const first = startHost(false);
  writeRequest(first.desktopInput, { id: 1, method: ACKNOWLEDGE, params: { version } });
  await expect(first.collector.waitFor((message) => requestId(message, 1))).resolves.toMatchObject(
    acknowledged,
  );
  await expect(first.host.handleClientRequest(GET, {})).resolves.toEqual(noAnnouncement);
  expect(github).not.toHaveBeenCalled();
  expect(
    JSON.parse(await readFile(join(directory, "release-announcement-v1.json"), "utf8")),
  ).toEqual({ acknowledgedVersion: version });
  await closeFixture(first);
  fixture = undefined;

  const restarted = startHost();
  await expect(restarted.host.handleClientRequest(GET, {})).resolves.toEqual(noAnnouncement);
  expect(github).not.toHaveBeenCalled();
  const manual = await restarted.host.handleClientRequest(GET, { manual: true });
  expect(manual).toMatchObject({ result: { announcement: { version }, unread: false } });
  expect(github).toHaveBeenCalledOnce();
  await expect(restarted.host.handleClientRequest(GET, { manual: true })).resolves.toEqual(manual);
  expect(github).toHaveBeenCalledOnce();
});

test("does not cache a GitHub failure and shares a successful result across concurrent queries", async () => {
  github.mockRejectedValueOnce(new Error("network unavailable"));
  const { host } = startHost();
  await expect(host.handleClientRequest(GET, {})).resolves.toEqual(noAnnouncement);
  const [first, second] = await Promise.all([
    host.handleClientRequest(GET, {}),
    host.handleClientRequest(GET, { manual: true }),
  ]);
  expect(first).toMatchObject({ result: { announcement: { version }, unread: true } });
  expect(second).toEqual(first);
  expect(
    releaseAnnouncementGetResultSchema.safeParse("result" in first && first.result).success,
  ).toBe(true);
  await expect(host.handleClientRequest(GET, {})).resolves.toEqual(first);
  expect(github).toHaveBeenCalledTimes(2);
});

test("rejects an acknowledgement for another version without recording it", async () => {
  const { host } = startHost();
  await expect(host.handleClientRequest(ACKNOWLEDGE, { version: "0.23.0" })).resolves.toMatchObject(
    { error: { code: -32602 } },
  );
  await expect(readFile(join(directory, "release-announcement-v1.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(host.handleClientRequest(GET, {})).resolves.toMatchObject({
    result: { unread: true },
  });
});
