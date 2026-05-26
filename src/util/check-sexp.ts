// Sanity check: read a file, verify parenthesis balance ignoring string contents.
// Usage: bun run src/util/check-sexp.ts <file>

const paths = Bun.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: check-sexp <file> [...]");
  process.exit(2);
}

const BACKSLASH = "\\";
const QUOTE = '"';

let anyFailed = false;
for (const path of paths) {
  const s = await Bun.file(path).text();
  let depth = 0;
  let inStr = false;
  let esc = false;
  let maxDepth = 0;
  let failed = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === BACKSLASH) esc = true;
      else if (c === QUOTE) inStr = false;
      continue;
    }
    if (c === QUOTE) inStr = true;
    else if (c === "(") {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    } else if (c === ")") {
      depth--;
      if (depth < 0) {
        console.error(`${path}: unmatched ')' at offset ${i}`);
        failed = true;
        break;
      }
    }
  }
  if (!failed && depth !== 0) {
    console.error(`${path}: unclosed parens: final depth = ${depth}`);
    failed = true;
  }
  if (!failed) {
    console.log(`${path}: balanced, max depth = ${maxDepth}, length = ${s.length}`);
  } else {
    anyFailed = true;
  }
}
process.exit(anyFailed ? 1 : 0);
