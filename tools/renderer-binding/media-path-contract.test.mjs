import { describe, expect, it } from "vitest";
import { discoverMediaPathContract, replayMediaPaths } from "./media-path-contract.mjs";
import { inspectMediaPaths } from "./media-path-probe.mjs";

const url = "app://-/assets/shared.js";
function modules(pathName = "pathParser", imageName = "imageToken") {
  return [
    {
      url,
      source: `
      function ${pathName}(value) { if (value.startsWith('file:')) return new URL(value).pathname; return decodeURI(value); }
      function imageSrc(value) { return ${pathName}(value); }
      function ${imageName}(token, key, context) { const component = context.components?.img; return { type: component, props: { src: imageSrc(token.href) } }; }
      export { ${pathName} as nativePath, ${imageName} as nativeImage };
    `,
    },
    {
      url: "app://-/assets/media.js",
      source: `
      import { nativePath as resolveSource } from './shared.js';
      function loadMedia(props, context) { const path = context.currentFilePath || props.src; const data = context.contentsBase64; return { path: resolveSource(path), data }; }
    `,
    },
  ];
}

describe("native media path contract", () => {
  it("discovers native import/export relationships without minified function names", () => {
    for (const names of [
      ["pathParser", "imageToken"],
      ["p7", "x0"],
    ]) {
      expect(discoverMediaPathContract(modules(...names))).toEqual({
        url,
        normalizer: "nativePath",
        imageRenderer: "nativeImage",
      });
    }
  });

  it("requires both image token conversion and a unique media loader using the same parser", () => {
    expect(discoverMediaPathContract([])).toBeNull();
    expect(discoverMediaPathContract(modules().slice(0, 1))).toBeNull();
    const duplicate = modules();
    duplicate.push({ ...duplicate[1], url: "app://-/assets/another-media.js" });
    expect(discoverMediaPathContract(duplicate)).toBeNull();
    const changed = modules();
    changed[0].source = changed[0].source.replace("return pathParser(value)", "return value");
    expect(discoverMediaPathContract(changed)).toBeNull();
  });

  it("calls native functions and detects changed normalization stages", () => {
    const contract = { normalizer: "path", imageRenderer: "image" };
    const image = (token) => ({ props: { src: decodeURI(token.href) } });
    const paths = ["/probe/%41.png", "/probe/%2F%5C.png", "C:/probe/中文 with space%.png"];
    expect(replayMediaPaths({ path: decodeURI, image }, contract, paths)).toEqual({
      state: "pass",
      checkedCases: 3,
      matchingCases: 3,
    });
    expect(replayMediaPaths({ path: (p) => p, image }, contract, paths).state).toBe("mismatch");
    expect(
      replayMediaPaths({ path: (p) => decodeURI(decodeURI(p)), image }, contract, paths.slice(0, 1))
        .state,
    ).toBe("mismatch");
    expect(replayMediaPaths({}, contract, paths).state).toBe("unverified");
    expect(
      replayMediaPaths(
        {
          path: decodeURI,
          image: () => {
            throw Error("changed API");
          },
        },
        contract,
        paths,
      ).state,
    ).toBe("unverified");
  });

  it("reports missing native structure as unverified without evaluating anything", async () => {
    const calls = [];
    let parsed;
    const client = {
      on: (_method, listener) => {
        parsed = listener;
        return () => {};
      },
      async command(method) {
        calls.push(method);
        if (method === "Debugger.enable") parsed({ isModule: true, url, scriptId: "1" });
        return { scriptSource: "export const unrelated = true;" };
      },
    };
    expect(await inspectMediaPaths(client, "app://-/index.html")).toEqual({
      state: "unverified",
      reason: "native-media-structure-missing-or-ambiguous",
    });
    expect(calls).toEqual(["Debugger.enable", "Debugger.getScriptSource"]);
  });

  it("does not evaluate a contract from a Renderer that reloaded during discovery", async () => {
    const sources = modules();
    const listeners = new Map();
    let evaluated = false;
    const client = {
      on: (method, listener) => {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      },
      async command(method, params) {
        if (method === "Debugger.enable")
          sources.forEach(({ url }, i) =>
            listeners.get("Debugger.scriptParsed")({ isModule: true, url, scriptId: String(i) }),
          );
        if (method === "Debugger.getScriptSource") {
          listeners.get("Debugger.globalObjectCleared")();
          return { scriptSource: sources[Number(params.scriptId)].source };
        }
        if (method === "Runtime.evaluate") evaluated = true;
        return {};
      },
    };
    expect(await inspectMediaPaths(client, "app://-/index.html")).toEqual({
      state: "unverified",
      reason: "renderer-changed-during-inspection",
    });
    expect(evaluated).toBe(false);
    expect(listeners.size).toBe(0);
  });

  it("evaluates only the verified native contract and returns bounded results", async () => {
    const sources = modules();
    const calls = [];
    let parsed;
    const client = {
      on: (_method, listener) => {
        parsed = listener;
        return () => {};
      },
      async command(method, params) {
        calls.push(method);
        if (method === "Debugger.enable")
          sources.forEach(({ url }, i) => parsed({ isModule: true, url, scriptId: String(i) }));
        if (method === "Debugger.getScriptSource")
          return { scriptSource: sources[Number(params.scriptId)].source };
        if (method === "Runtime.evaluate") {
          expect(params.expression).toContain("nativeImage");
          expect(params.expression).not.toMatch(/readBinary|createRoot|appendChild|sendRequest/);
          return { result: { value: { state: "pass", checkedCases: 6, matchingCases: 6 } } };
        }
        return {};
      },
    };
    expect(await inspectMediaPaths(client, "app://-/index.html")).toEqual({
      state: "pass",
      checkedCases: 6,
      matchingCases: 6,
    });
    expect(calls).toEqual([
      "Debugger.enable",
      "Debugger.getScriptSource",
      "Debugger.getScriptSource",
      "Runtime.evaluate",
    ]);
  });
});
