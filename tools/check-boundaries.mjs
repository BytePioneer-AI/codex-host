import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packagesRoot = resolve(repositoryRoot, "packages");
const rendererRoot = resolve(packagesRoot, "renderer-extension");
const sharedContractsRoot = resolve(packagesRoot, "shared-contracts", "src");
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

const forbiddenLocalRuntimePackages = new Set([
  "@agentclientprotocol/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "@openai/codex-sdk",
  "electron",
]);

function isInside(candidate, parent) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..")
  );
}

function packageRootFor(filePath) {
  let current = dirname(filePath);

  while (isInside(current, packagesRoot)) {
    if (existsSync(resolve(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

function moduleSpecifiers(sourceText, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers = [];

  function addStringLiteral(node) {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) addStringLiteral(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function isPackageOrSubpath(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function isForbiddenLocalRuntimeImport(specifier) {
  const normalized = specifier.replace(/^node:/u, "");
  if (builtins.has(normalized)) return true;
  for (const packageName of forbiddenLocalRuntimePackages) {
    if (isPackageOrSubpath(specifier, packageName)) return true;
  }
  if (specifier.startsWith("@earendil-works/pi-")) return true;
  return /(^|\/)pi-(agent|ai|coding-agent)(\/|$)/u.test(specifier);
}

export function findSourceBoundaryViolations({
  filePath,
  packageRoot,
  sourceText,
  packagesDirectory = packagesRoot,
  rendererDirectory = rendererRoot,
  sharedContractsDirectory = sharedContractsRoot,
}) {
  const violations = [];

  for (const specifier of moduleSpecifiers(sourceText, filePath)) {
    if (isInside(filePath, rendererDirectory) && isForbiddenLocalRuntimeImport(specifier)) {
      violations.push(`${filePath}: Renderer cannot import '${specifier}'`);
    }

    if (
      isInside(filePath, sharedContractsDirectory) &&
      (isForbiddenLocalRuntimeImport(specifier) || specifier.startsWith("@codexhost/"))
    ) {
      violations.push(`${filePath}: Shared Contracts cannot import '${specifier}'`);
    }

    if (specifier.startsWith(".") || isAbsolute(specifier)) {
      const importedPath = resolve(dirname(filePath), specifier);
      if (isInside(importedPath, packagesDirectory) && !isInside(importedPath, packageRoot)) {
        violations.push(`${filePath}: cross-package source import '${specifier}' is forbidden`);
      }
    }

    if (
      (specifier.startsWith("@codexhost/") && specifier.includes("/src")) ||
      /(^|\/)packages\/.*\/src(\/|$)/u.test(specifier)
    ) {
      violations.push(`${filePath}: import '${specifier}' bypasses a package's public exports`);
    }
  }

  return violations;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(entryPath)));
    } else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function findRepositoryBoundaryViolations() {
  const files = await sourceFiles(packagesRoot);
  const violations = [];

  for (const filePath of files) {
    const packageRoot = packageRootFor(filePath);
    if (!packageRoot) {
      violations.push(`${filePath}: file is not owned by a Workspace package`);
      continue;
    }

    const sourceText = await readFile(filePath, "utf8");
    violations.push(...findSourceBoundaryViolations({ filePath, packageRoot, sourceText }));
  }

  return violations;
}

const executedFile = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (executedFile === fileURLToPath(import.meta.url)) {
  const violations = await findRepositoryBoundaryViolations();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }
}
