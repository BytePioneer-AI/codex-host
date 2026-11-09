/** Import official terminal codecs into the embedded Gateway's descriptor-array format. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const source = resolve(process.argv[2] ?? "");
const target = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(source, "package.json"), "utf8"));
if (
  manifest.name !== "@deepseek-ai/dsh-api-terminal-controller" ||
  manifest.version !== "0.2.2-alpha.2"
) {
  throw new Error("Expected the unpacked official terminal-controller 0.2.2-alpha.2 package");
}
const factory = ts.factory;
const printer = ts.createPrinter();
const property = (name, value) => factory.createPropertyAssignment(name, value);
const literal = (value) => factory.createStringLiteral(value);
const field = (object, name) => {
  if (!ts.isObjectLiteralExpression(object)) throw new Error(`Expected an object for ${name}`);
  const member = object.properties.find(
    (entry) => entry.name?.getText().replaceAll(/['"]/g, "") === name,
  );
  if (!member || !ts.isPropertyAssignment(member))
    throw new Error(`Missing generated field ${name}`);
  return member.initializer;
};

for (const [input, output] of [
  ["typert.host.js", "host/typert.host.js"],
  ["typert.remote-client.js", "generated/remote.js"],
]) {
  const file = ts.createSourceFile(
    input,
    await readFile(resolve(source, "lib", input), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let converted = 0;
  const transformed = ts.transform(file, [
    (context) => {
      const visit = (node) => {
        if (
          ts.isImportDeclaration(node) &&
          node.moduleSpecifier.text === "@deepseek-ai/dsh-typert-protocol/remote-info"
        )
          return undefined;
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(file) === "createTypertRemoteInfo"
        ) {
          converted++;
          const spec = node.arguments[0];
          const packageName = field(spec, "package");
          const methods = field(spec, "methods");
          const descriptors = methods.properties.map((entry) => {
            const endpoint = entry.name.text;
            const [namespace, method] = endpoint.split("/");
            const definition = entry.initializer;
            const parameters = field(definition, "parameters");
            return factory.createObjectLiteralExpression(
              [
                property("id", literal(`${packageName.text}#${endpoint}`)),
                property("namespace", literal(namespace)),
                property("method", literal(method)),
                ...definition.properties.filter(
                  (member) => member.name.getText(file) !== "parameters",
                ),
                property(
                  "parameters",
                  factory.createArrayLiteralExpression(
                    parameters.elements.map((parameter) => {
                      const hasWire = parameter.properties.some(
                        (member) => member.name.getText(file) === "wire",
                      );
                      return factory.createObjectLiteralExpression(
                        [
                          ...parameter.properties,
                          ...(hasWire ? [] : [property("wire", field(parameter, "name"))]),
                        ],
                        true,
                      );
                    }),
                    true,
                  ),
                ),
              ],
              true,
            );
          });
          return factory.createObjectLiteralExpression(
            [
              property("package", packageName),
              property("descriptors", factory.createArrayLiteralExpression(descriptors, true)),
            ],
            true,
          );
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (root) => ts.visitNode(root, visit);
    },
  ]);
  if (converted !== 1) throw new Error(`Expected one generated Remote definition in ${input}`);
  await writeFile(resolve(target, output), printer.printFile(transformed.transformed[0]));
  transformed.dispose();
}
const declarations = await readFile(resolve(source, "lib/typert.remote-client.d.ts"), "utf8");
const definition = declarations.indexOf("export declare const TYPERT_REMOTE:");
if (definition < 0) throw new Error("Missing generated Remote declaration");
await writeFile(
  resolve(target, "generated/remote.d.ts"),
  declarations
    .slice(0, definition)
    .replace("  TypertRemoteInfo,\n  TypertRemoteMethod,", "  InvocationDescriptor,") +
    "export declare const TYPERT_REMOTE: { readonly package: string; readonly descriptors: readonly InvocationDescriptor[] };\nexport default TYPERT_REMOTE;\n",
);
await writeFile(
  resolve(target, "host/typert.host.d.ts"),
  await readFile(resolve(source, "lib/typert.host.d.ts")),
);
