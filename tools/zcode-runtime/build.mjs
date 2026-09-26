import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { patchNativeSource } from "./native-source-patches.mjs";

const exec = promisify(execFile);
const revision = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--output") {
  throw new Error(
    "Usage: node tools/zcode-runtime/build.mjs --source <ZCode checkout> --output <new runtime directory>",
  );
}
const source = path.resolve(args[1]);
const output = path.resolve(args[3]);
const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
if (head !== revision) throw new Error(`ZCode source must be pinned to ${revision}`);
const dirty = (await exec("git", ["diff", "HEAD", "--name-only"], { cwd: source })).stdout.trim();
if (dirty) throw new Error("ZCode tracked source must be unchanged");
await mkdir(path.dirname(output), { recursive: true });
// Never overwrite an installed or currently executing runtime in place.
await mkdir(output);
const alias = {};
for (const directory of await readdir(path.join(source, "packages"))) {
  const root = path.join(source, "packages", directory);
  let pkg;
  try {
    pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    if (typeof value === "string" && !key.includes("*"))
      alias[pkg.name + (key === "." ? "" : key.slice(1))] = path.join(root, value);
  }
}
// native-source-patches.mjs changes exactly four pinned source files; an alias or filter
// that misses one would otherwise ship an unpatched runtime.
const patched = new Set();
await build({
  absWorkingDir: source,
  entryPoints: [
    path.resolve(import.meta.dirname, "../../packages/adapters/zcode/runtime/worker.mjs"),
  ],
  outfile: path.join(output, "worker.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  alias,
  nodePaths: [
    path.join(source, "node_modules"),
    path.join(source, "node_modules/.pnpm/node_modules"),
  ],
  external: ["node-pty", "*.node"],
  plugins: [
    {
      name: "zcode-native-source-patches",
      setup(builder) {
        builder.onLoad(
          {
            filter:
              /(?:clientConfig|zcodeAgentService|node)\.ts$|[/\\]zcode-protocol[/\\]index\.ts$/,
          },
          async ({ path: file }) => {
            const original = await readFile(file, "utf8");
            const normalized = file.replaceAll("\\", "/");
            const contents = patchNativeSource(normalized, original);
            if (contents === undefined) return undefined;
            patched.add(normalized);
            return { contents, loader: "ts" };
          },
        );
      },
    },
  ],
  banner: {
    js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href; var __import_meta_dirname = __dirname;',
  },
  define: {
    "import.meta.url": "__import_meta_url",
    "import.meta.dirname": "__import_meta_dirname",
    __ZCODE_VERSION__: JSON.stringify("3.14.3"),
    __ZCODE_ENV__: JSON.stringify("production"),
  },
  legalComments: "eof",
  metafile: true,
});
if (patched.size !== 4)
  throw new Error(`Expected 4 patched ZCode source files, applied ${patched.size}`);
// node-pty loads a native addon; keep its package layout instead of embedding binary paths.
const require = createRequire(path.join(source, "packages/server/package.json"));
const copied = new Set();
async function copyDependency(name, resolver) {
  if (copied.has(name)) return;
  copied.add(name);
  const manifest = resolver.resolve(`${name}/package.json`);
  const pkg = JSON.parse(await readFile(manifest, "utf8"));
  await cp(path.dirname(manifest), path.join(output, "node_modules", name), {
    recursive: true,
    dereference: true,
  });
  const childResolver = createRequire(manifest);
  for (const dependency of Object.keys(pkg.dependencies ?? {}))
    await copyDependency(dependency, childResolver);
}
await copyDependency("node-pty", require);
const agentDist = path.join(source, "apps/zcode-cli/packages/cli/dist");
await mkdir(path.join(output, "agent"), { recursive: true });
await cp(path.join(agentDist, "zcode.cjs"), path.join(output, "agent/zcode.cjs"));
await cp(path.join(agentDist, "provider"), path.join(output, "agent/provider"), {
  recursive: true,
});
for (const name of ["LICENSE", "NOTICE.md", "THIRD-PARTY-NOTICES.md"]) {
  await cp(path.join(source, name), path.join(output, name));
}
await cp(path.join(source, "third-party"), path.join(output, "third-party"), { recursive: true });
await writeFile(
  path.join(output, "runtime.json"),
  JSON.stringify(
    {
      formatVersion: 1,
      version: "3.14.3",
      sourceRevision: revision,
      entry: "worker.cjs",
      agent: "agent/zcode.cjs",
      providerConfig: "agent/provider/zcode-builtin.json",
      agentVersion: "0.16.9",
      nodeMajor: 24,
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  path.join(output, "CODEXHOST-MODIFICATIONS.md"),
  `Source: zai-org/ZCode@${revision}\n\nThis runtime adds a local stdio service facade and a per-request CAPTCHA header callback using the official SDK traceless verification and interactive fallback in the Codex browser. Public CAPTCHA configuration is projected from the native client config service. Native cancellation aborts pending verification. The Services turn.started schema accepts the executionStartedAt timestamp emitted by the same-source CLI, preserving its native Turn identity. Account credentials, entitlement checks, Agent execution and persistence remain in ZCode. Changes are maintained in codexhost tools/zcode-runtime/native-source-patches.mjs and packages/adapters/zcode/runtime/.\n`,
);
console.log(`Built ZCode native service runtime at ${output}`);
