/** `multisim2kicad` command-line entry point (the published bin). */
import { errorMessage, main, UsageError } from "./main.ts";

main().catch((err) => {
  if (err instanceof UsageError) {
    // Usage text goes out as-is; other usage errors get the command's name.
    console.error(err.message.startsWith("usage:") ? err.message : `multisim2kicad: ${err.message}`);
    process.exit(err.exitCode);
  }
  console.error(`multisim2kicad: ${errorMessage(err)}`);
  if (process.argv.includes("--debug")) console.error(err);
  else console.error("(run again with --debug for details, and please report it: https://github.com/cinderblock/multisim2kicad/issues)");
  process.exit(1);
});
