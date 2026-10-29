// The real-npm fixtures use the same JavaScript package generators as release tests.
declare module "*scripts/release/prepare-npm-meta.mjs" {
  export function createNpmMetaPackageManifest(options: {
    version: string;
  }): Record<string, unknown>;
}
declare module "*scripts/release/prepare-npm.mjs" {
  export function createNpmPackageManifest(options: {
    version: string;
    target: Record<string, unknown>;
  }): Record<string, unknown>;
  export function createNpmBinLauncherSource(options: { version: string }): string;
}
declare module "*scripts/release/targets.mjs" {
  export function releaseTarget(id: string): Record<string, unknown> & { id: string };
}
