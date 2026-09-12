// Public, source-distributed entry point. Trusted GitHub workflows import this
// file directly so they never need npm install, lifecycle scripts or a build.
export { runMaintenance, maintainItem } from "./src/maintenance.mjs";
export {
  resolveRelease,
  verifyRelease,
  readReleaseMetadata,
  assertReleaseCi,
  validateReleaseVersion,
} from "./src/release.mjs";
