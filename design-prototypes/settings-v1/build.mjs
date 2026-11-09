import { copyFileSync, cpSync, mkdirSync } from "node:fs";

const output = new URL("./dist/", import.meta.url);
mkdirSync(output, { recursive: true });
for (const name of [
  "index.html",
  "styles.css",
  "app.js",
  "launch-dialog.css",
  "launch-dialog.js",
  "review.html",
  "review.css",
  "README.md",
]) {
  copyFileSync(new URL(name, import.meta.url), new URL(name, output));
}
cpSync(new URL("./previews/", import.meta.url), new URL("./previews/", output), {
  recursive: true,
});
console.log("Built standalone prototype: design-prototypes/settings-v1/dist/index.html");
