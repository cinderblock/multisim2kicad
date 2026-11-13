/**
 * Builds what ships in the npm package:
 *
 * - `dist/cli.js`: the `multisim2kicad` command, an ESM bundle with a node shebang.
 * - `dist/index.js`: the library API (ESM).
 *
 * `electronics-workbench-decoder` stays a runtime dependency (not inlined),
 * so fixes there reach multisim2kicad users without a new multisim2kicad release. Type
 * declarations come from `tsc -p tsconfig.build.json` in the `build` script.
 */

import { type BuildConfig, build } from "bun";
import { rm } from "node:fs/promises";

async function run(label: string, config: BuildConfig) {
  const result = await build(config);
  if (!result.success) {
    console.error(`build failed: ${label}`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  for (const out of result.outputs) console.log(`built ${out.path}`);
}

await rm("dist", { recursive: true, force: true });
const common = { outdir: "dist", target: "node", format: "esm", packages: "external" } as const;
await run("cli", { ...common, entrypoints: ["src/cli.ts"], banner: "#!/usr/bin/env node" });
await run("lib", { ...common, entrypoints: ["src/index.ts"] });
