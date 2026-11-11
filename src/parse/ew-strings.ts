// Multisim string types:
//   &ASC<text>           -> plain ASCII text after the prefix.
//   &UNI<text + escapes> -> text with `_uc<count><4hex>...` sequences for
//                          non-ASCII characters (e.g. `_uc100b5F` -> µF,
//                          `_uc103a9` -> Ω). Literal newlines may appear.
export const decodeStr = (s: unknown): string => {
  if (s == null) return "";
  const v = String(s);
  if (v.startsWith("&ASC")) return v.slice(4);
  if (v.startsWith("&UNI")) {
    return v.slice(4).replace(/_uc(\d)((?:[0-9a-fA-F]{4})+)/g, (_full, countStr, hex) => {
      const n = Number(countStr);
      let out = "";
      for (let i = 0; i < n; i++) out += String.fromCharCode(parseInt(hex.slice(i * 4, (i + 1) * 4), 16));
      return out;
    });
  }
  return v;
};

