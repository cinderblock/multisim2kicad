// Sanity check: read a file, verify parenthesis balance ignoring string contents.
// Usage: bun run src/util/check-sexp.ts <file>

const path = Bun.argv[2];
if (!path) {
  console.error("usage: check-sexp <file>");
  process.exit(2);
}

const s = await Bun.file(path).text();
let depth = 0;
let inStr = false;
let esc = false;
let maxDepth = 0;
const BACKSLASH = "\\";
const QUOTE = '"';

for (let i = 0; i < s.length; i++) {
  const c = s[i];
  if (esc) {
    esc = false;
    continue;
  }
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
      console.error(`unmatched ')' at offset ${i}`);
      process.exit(1);
    }
  }
}

if (depth !== 0) {
  console.error(`unclosed parens: final depth = ${depth}`);
  process.exit(1);
}
console.log(`${path}: balanced, max depth = ${maxDepth}, length = ${s.length}`);
