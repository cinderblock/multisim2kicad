import { describe, expect, test } from "bun:test";
import { errorMessage, main, packageVersion, UsageError } from "./main.ts";
import pkg from "../package.json";

describe("command line", () => {
  test("--version matches package.json", async () => {
    expect(await packageVersion()).toBe(pkg.version);
  });

  test("no inputs is a usage error", async () => {
    await expect(main([])).rejects.toBeInstanceOf(UsageError);
  });

  test("unknown options are rejected, not read as files", async () => {
    await expect(main(["--bogus"])).rejects.toThrow("unknown option --bogus");
  });

  test("-o without a folder is a usage error", async () => {
    await expect(main(["-o"])).rejects.toThrow("-o needs a folder");
  });

  test("a missing input is one line, exit 1", async () => {
    const err = await main(["no-such-design.ms14"]).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toBe("no-such-design.ms14: no such file or directory");
  });

  test("errorMessage turns ENOENT into a short line", () => {
    const e = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT", path: "x.ms14" });
    expect(errorMessage(e)).toBe("x.ms14: no such file or directory");
  });
});
