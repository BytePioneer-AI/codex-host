import ts from "typescript";

const SAMPLE_PATHS = [
  "/codexhost-media-probe/literal%.png",
  "/codexhost-media-probe/%41.png",
  "/codexhost-media-probe/%25%2F%5C.png",
  "/codexhost-media-probe/%E4%B8%AD%E6%96%87.png",
  "/codexhost-media-probe/中文 with space#?.png",
  "C:/codexhost-media-probe/C%3A%5Cdir/a.png",
];

function nodesMatching(node, predicate) {
  const matches = [];
  const visit = (child) => {
    if (predicate(child)) matches.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return matches;
}

/** Inspect loaded module source only; names below are recovered from its import/export edges. */
export function discoverMediaPathContract(modules) {
  const summaries = modules
    .filter(({ source }) => source.includes("decodeURI") || source.includes("currentFilePath"))
    .map(({ url, source }) => {
      const tree = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const functions = new Map();
      const exports = new Map();
      const imports = [];
      for (const node of tree.statements) {
        if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
        if (
          ts.isExportDeclaration(node) &&
          node.exportClause &&
          ts.isNamedExports(node.exportClause)
        ) {
          for (const specifier of node.exportClause.elements)
            exports.set((specifier.propertyName ?? specifier.name).text, specifier.name.text);
        }
        if (
          ts.isImportDeclaration(node) &&
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)
        ) {
          for (const specifier of node.importClause.namedBindings.elements)
            imports.push({
              local: specifier.name.text,
              exported: (specifier.propertyName ?? specifier.name).text,
              url: new URL(node.moduleSpecifier.text, url).href,
            });
        }
      }
      const calls = (node) =>
        nodesMatching(node, ts.isCallExpression).flatMap(({ expression }) =>
          ts.isIdentifier(expression) ? [expression.text] : [],
        );
      const hasProperty = (node, name) =>
        nodesMatching(node, ts.isPropertyAccessExpression).some(
          (access) => access.name.text === name,
        );
      const reaches = (name, target, depth = 2) =>
        name === target ||
        (depth > 0 &&
          functions.has(name) &&
          calls(functions.get(name)).some((next) => reaches(next, target, depth - 1)));
      const normalizers = [...functions].filter(
        ([name, node]) =>
          exports.has(name) &&
          calls(node).includes("decodeURI") &&
          nodesMatching(node, ts.isStringLiteralLike).some((literal) => literal.text === "file:"),
      );
      const pairs = normalizers.flatMap(([name]) =>
        [...functions].flatMap(([renderer, node]) =>
          exports.has(renderer) &&
          hasProperty(node, "img") &&
          hasProperty(node, "components") &&
          reaches(renderer, name)
            ? [{ url, normalizer: exports.get(name), imageRenderer: exports.get(renderer) }]
            : [],
        ),
      );
      const consumers = [...functions.values()]
        .filter(
          (node) => hasProperty(node, "currentFilePath") && hasProperty(node, "contentsBase64"),
        )
        .flatMap((node) => imports.filter(({ local }) => calls(node).includes(local)));
      return { pairs, consumers };
    });
  const pairs = summaries.flatMap(({ pairs }) => pairs);
  if (pairs.length !== 1) return null;
  const pair = pairs[0];
  const consumers = summaries
    .flatMap(({ consumers }) => consumers)
    .filter(({ url, exported }) => url === pair.url && exported === pair.normalizer);
  return consumers.length === 1 ? pair : null;
}

/** No mounting, file reads or network requests: the native token renderer returns a React element. */
export function replayMediaPaths(nativeModule, contract, paths) {
  const unverified = { state: "unverified", reason: "native-media-functions-unavailable" };
  const render = nativeModule[contract.imageRenderer];
  const normalize = nativeModule[contract.normalizer];
  if (typeof render !== "function" || typeof normalize !== "function") return unverified;
  try {
    const results = paths.map((path) => {
      const element = render(
        { type: "image", text: "probe", href: path.replaceAll("%", "%2525") },
        "probe",
        { components: { img: function ProbeImage() {} } },
      );
      const src = element?.props?.src;
      return (
        typeof src === "string" && src === path.replaceAll("%", "%25") && normalize(src) === path
      );
    });
    const matchingCases = results.filter(Boolean).length;
    return {
      state: matchingCases === paths.length ? "pass" : "mismatch",
      checkedCases: paths.length,
      matchingCases,
    };
  } catch {
    return unverified;
  }
}

export function mediaPathProbeExpression(contract) {
  return `(async () => {
    const url = new URL(${JSON.stringify(contract.url)});
    if (url.protocol !== location.protocol || url.host !== location.host)
      return { state: 'unverified', reason: 'native-module-origin-mismatch' };
    try {
      const native = await import(url.href);
      return (${replayMediaPaths.toString()})(native, ${JSON.stringify(contract)}, ${JSON.stringify(SAMPLE_PATHS)});
    } catch {
      return { state: 'unverified', reason: 'native-module-import-unavailable' };
    }
  })()`;
}
