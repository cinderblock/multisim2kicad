/**
 * Minimal reader for KiCad S-expression files (netlists, schematics, boards).
 *
 * Atoms are returned as strings; quoted strings are unescaped (`\"`, `\\`,
 * `\n`, `\t`). A quoted atom is wrapped so callers can tell `"1"` from `1`
 * when it matters; most callers just use `atom()`.
 */
export type Sexpr = string | Sexpr[];

export function parseSexpr(text: string): Sexpr[] {
  const root: Sexpr[] = [];
  const stack: Sexpr[][] = [root];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 40 /* ( */) {
      const list: Sexpr[] = [];
      stack[stack.length - 1]!.push(list);
      stack.push(list);
      i++;
    } else if (c === 41 /* ) */) {
      if (stack.length === 1) throw new Error(`sexpr: unbalanced ")" at offset ${i}`);
      stack.pop();
      i++;
    } else if (c === 34 /* " */) {
      let out = "";
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error(`sexpr: unterminated string at offset ${i}`);
        const d = text[j]!;
        if (d === '"') break;
        if (d === "\\" && j + 1 < n) {
          const e = text[j + 1]!;
          out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
          j += 2;
        } else {
          out += d;
          j++;
        }
      }
      stack[stack.length - 1]!.push(out);
      i = j + 1;
    } else if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
    } else {
      let j = i;
      while (j < n && !" \t\r\n()\"".includes(text[j]!)) j++;
      stack[stack.length - 1]!.push(text.slice(i, j));
      i = j;
    }
  }
  if (stack.length !== 1) throw new Error(`sexpr: ${stack.length - 1} unclosed "(" at end of input`);
  return root;
}

export const isList = (x: Sexpr | undefined): x is Sexpr[] => Array.isArray(x);
export const headOf = (x: Sexpr | undefined): string | undefined =>
  isList(x) && typeof x[0] === "string" ? x[0] : undefined;
/** Child lists of `x` whose head is `name`. */
export const listsNamed = (x: Sexpr[], name: string): Sexpr[][] =>
  x.filter((c): c is Sexpr[] => headOf(c) === name);
/** First atom of the first child list named `name` (e.g. `(ref "R1")` -> "R1"). */
export const atom = (x: Sexpr[], name: string): string | undefined => {
  const v = listsNamed(x, name)[0]?.[1];
  return typeof v === "string" ? v : undefined;
};
