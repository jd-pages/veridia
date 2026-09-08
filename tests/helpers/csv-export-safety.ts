// Harmless arithmetic only; never exercise external links, DDE or commands.
export const csvDangerousTextCases = [
  ...["=1+1", "+1+1", "-1+1", "@SUM(1,1)"].map(value => ({ name: `direct ${value[0]}`, value })),
  ...[" ", "\t", "\r", "\n", "\r\n", " \t\r\n", "\u0000", "\u000b", "\u001f", "\u007f", "\u0085", "\u00a0", "\u2003", "\u200b", "\u200e", "\u2060", "\ufeff", "\u3000"].flatMap(leading =>
    ["=1+1", "+1+1", "-1+1", "@SUM(1,1)"].map(value => ({ name: `${JSON.stringify(leading)} ${value[0]}`, value: leading + value })),
  ),
  ...['=SUM(1,2)', '=1+1\n业务备注', '=1+1\r\n"保留引号",中文🙂', '＝1+1', '＋1+1', '－1+1', '＠SUM(1,1)'].map(value => ({ name: JSON.stringify(value), value })),
];

export const csvNormalTexts = [
  "普通中文 English 🙂", "", " hello ", "  \t普通文本  ", "a,b", 'a"b',
  '"=1+1"', '"quoted",=1+1', "line1\nline2", "line1\r\nline2", "line1\rline2",
  "前缀=1+1", "邮箱 user@example.com", "2026-09-08", "001234", "'=1+1", "'=已有标记",
  "中文🙂,\"长段\"\r\n".repeat(4000),
];

// Independent RFC-style parser for inspecting final exported bytes. No formula
// neutralization here: tests assert the exact parsed cell and original suffix.
export function csvCells(csv: string): string[][] {
  const source = csv.replace(/^\uFEFF/u, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (!quoted && ch === ",") { row.push(cell); cell = ""; }
    else if (!quoted && (ch === "\r" || ch === "\n")) {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (quoted) throw new Error("Unterminated CSV quote");
  row.push(cell); rows.push(row);
  return rows;
}
