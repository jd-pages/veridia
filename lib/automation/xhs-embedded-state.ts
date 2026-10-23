/** XHS serializes data using JSON literals plus undefined/Map/Set. Parse data
 * only: no eval, Function, property access, methods, expressions or JS execution. */
export function parseXhsEmbeddedState(script: string): unknown | null {
  if (!script || script.length > 4_000_000) return null;
  const assignment = /^\s*(?:window\.)?__(?:INITIAL_STATE|NEXT_DATA)__\s*=\s*/u.exec(script);
  const text = assignment ? script.slice(assignment[0].length) : script.trim();
  let index = 0, nodes = 0;
  const whitespace = () => { while (/\s/u.test(text[index] || "") && index < text.length) index++; };
  const take = (token: string) => {
    whitespace();
    if (text.slice(index, index + token.length) !== token) throw new Error("INVALID_DATA_LITERAL");
    index += token.length;
  };
  const string = () => {
    take('"'); const start = index - 1;
    while (index < text.length) {
      const character = text[index++];
      if (character === "\\") { index++; continue; }
      if (character === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    throw new Error("UNTERMINATED_DATA_STRING");
  };
  const value = (depth: number): unknown => {
    if (++nodes > 20_000 || depth > 80) throw new Error("DATA_BUDGET_EXCEEDED");
    whitespace();
    const character = text[index];
    if (character === '"') return string();
    if (character === "{") {
      index++; whitespace();
      const record: Record<string, unknown> = Object.create(null);
      if (text[index] !== "}") for (;;) {
        whitespace(); const key = string(); take(":");
        if (Object.hasOwn(record, key)) throw new Error("DUPLICATE_DATA_KEY");
        record[key] = value(depth + 1); whitespace();
        if (text[index] !== ",") break;
        index++;
      }
      take("}"); return record;
    }
    if (character === "[") {
      index++; whitespace(); const array: unknown[] = [];
      if (text[index] !== "]") for (;;) {
        array.push(value(depth + 1)); whitespace();
        if (text[index] !== ",") break;
        index++;
      }
      take("]"); return array;
    }
    const collection = /^new\s+(Map|Set)\s*\(/u.exec(text.slice(index));
    if (collection) {
      index += collection[0].length;
      const entries = value(depth + 1); take(")");
      if (!Array.isArray(entries)) throw new Error("INVALID_DATA_COLLECTION");
      if (collection[1] === "Set") return entries;
      const record: Record<string, unknown> = Object.create(null);
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || Object.hasOwn(record, entry[0])) {
          throw new Error("INVALID_DATA_MAP");
        }
        record[entry[0]] = entry[1];
      }
      return record;
    }
    for (const [token, literal] of [["true", true], ["false", false], ["null", null], ["undefined", null]] as const) {
      if (text.slice(index, index + token.length) === token) { index += token.length; return literal; }
    }
    const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index));
    if (!numeric || !Number.isFinite(Number(numeric[0]))) throw new Error("INVALID_DATA_VALUE");
    index += numeric[0].length; return Number(numeric[0]);
  };
  try {
    const output = value(0); whitespace();
    if (text[index] === ";") { index++; whitespace(); }
    return index === text.length ? output : null;
  } catch { return null; }
}
