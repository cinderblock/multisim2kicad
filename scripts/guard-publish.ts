/**
 * `prepublishOnly` guard: releases are published from CI only (with
 * provenance). The one local exception is the `0.0.0` placeholder that
 * claims the npm name so trusted publishing can be configured on it.
 */
import pkg from "../package.json" with { type: "json" };

if (!process.env.CI && pkg.version !== "0.0.0") {
  console.error(`Refusing to publish ${pkg.name}@${pkg.version} outside CI. Push a v${pkg.version} tag instead.`);
  process.exit(1);
}
