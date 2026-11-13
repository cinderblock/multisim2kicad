/** `ew-conv` command-line entry point (the published bin). */
import { main } from "./main.ts";

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
