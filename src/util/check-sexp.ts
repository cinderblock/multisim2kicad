// Sanity check: verify S-expression parenthesis balance, ignoring string
// contents (with backslash escapes).
// CLI usage: bun run src/util/check-sexp.ts <file> [...]

export interface SexpCheck {
  ok: boolean;
  maxDepth: number;
  /** Description of the first problem, when !ok. */
  error?: string;
}

export function checkSexp(s: string): SexpCheck {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let maxDepth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(") { depth++; maxDepth = Math.max(maxDepth, depth); }
    else if (c === ")") {
      depth--;
      if (depth < 0) return { ok: false, maxDepth, error: `unbalanced ")" at offset ${i}` };
    }
  }
  if (inStr) return { ok: false, maxDepth, error: "unterminated string" };
  if (depth !== 0) return { ok: false, maxDepth, error: `${depth} unclosed "("` };
  return { ok: true, maxDepth };
}

if (import.meta.main) {
  const paths = Bun.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: check-sexp <file> [...]");
    process.exit(2);
  }
  let anyFailed = false;
  for (const path of paths) {
    const r = checkSexp(await Bun.file(path).text());
    console.log(`${path}: ${r.ok ? `ok (max depth ${r.maxDepth})` : `FAIL: ${r.error}`}`);
    if (!r.ok) anyFailed = true;
  }
  process.exit(anyFailed ? 1 : 0);
}
