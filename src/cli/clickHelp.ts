/** Click 8.3 HelpFormatter's text layout, at the CLI's stable 80-column width. */
export const HELP_WIDTH = 80;
const SPACE = "[\\t\\n\\v\\f\\r ]";
const WORD = "[\\p{L}\\p{N}_]";
const LETTER = "[\\p{L}\\p{Nl}\\p{No}_]";
const END_WORD = `[\\p{L}\\p{N}_!"'&.,?]`;
// Python textwrap's wordsep_re, including its treatment of hyphenated words.
const CHUNKS = new RegExp(
  `${SPACE}+|(?<=${END_WORD})-{2,}(?=${WORD})|` +
  `[^\\t\\n\\v\\f\\r ]+?(?:-(?:(?<=${LETTER}{2}-)|(?<=${LETTER}-${LETTER}-))(?=${LETTER}-?${LETTER})|` +
  `(?=${SPACE}|$)|(?<=${END_WORD})(?=-{2,}${WORD}))`, "gu",
);
const whitespace = (value: string) => /^[\t\n\v\f\r ]+$/.test(value);
const length = (value: string) => [...value].length;

function expandTabs(text: string): string {
  let column = 0;
  let result = "";
  for (const char of text) {
    if (char === "\t") {
      const spaces = 8 - column % 8;
      result += " ".repeat(spaces);
      column += spaces;
    } else {
      result += char;
      column = char === "\n" || char === "\r" ? 0 : column + 1;
    }
  }
  return result;
}

export function wrapText(text: string, width: number, initial = "", subsequent = initial): string {
  const chunks = expandTabs(text).match(CHUNKS) ?? [];
  const lines: string[] = [];
  while (chunks.length) {
    const indent = lines.length ? subsequent : initial;
    const available = width - length(indent);
    if (lines.length && whitespace(chunks[0]!)) chunks.shift();
    const line: string[] = [];
    let used = 0;
    while (chunks.length && used + length(chunks[0]!) <= available) {
      const chunk = chunks.shift()!;
      line.push(chunk);
      used += length(chunk);
    }
    if (chunks.length && length(chunks[0]!) > available) {
      const chars = [...chunks[0]!];
      const take = Math.max(available - used, 1);
      line.push(chars.slice(0, take).join(""));
      chunks[0] = chars.slice(take).join("");
      if (!chunks[0]) chunks.shift();
    }
    if (line.length && whitespace(line.at(-1)!)) line.pop();
    if (line.length) lines.push(indent + line.join(""));
  }
  return lines.join("\n");
}

/** Reflow prose paragraphs, retaining the CLI declarations' literal examples. */
export function formatParagraphs(text: string, width = HELP_WIDTH, indent = "  "): string {
  return text.trim().split(/\n\s*\n/).map(block => {
    const lines = block.split("\n");
    const first = lines[0]!.trimStart();
    if (first === "\b" || /^(?:Examples?|Usage):$/.test(first)) {
      if (first === "\b") return lines.slice(1).map(line => indent + line).join("\n");
      return lines.map((line, i) => indent + (i === 0 ? line.trimStart() : line.replace(/^  /, ""))).join("\n");
    }
    return wrapText(lines.map(line => line.trim()).join(" "), width, indent);
  }).join("\n\n");
}

export function formatUsage(path: string, args: string): string {
  const prefix = `Usage: ${path} `;
  if (!args) return "";
  if (HELP_WIDTH >= length(prefix) + 20) return wrapText(args, HELP_WIDTH, prefix, " ".repeat(length(prefix)));
  return prefix + "\n" + wrapText(args, HELP_WIDTH, " ".repeat(11));
}

export function formatTable(rows: readonly (readonly [string, string])[]): string {
  const column = Math.min(Math.max(0, ...rows.map(([first]) => length(first))), 30) + 2;
  return rows.map(([first, second]) => {
    if (!second) return `  ${first}`;
    const prefix = length(first) <= column - 2
      ? `  ${first}${" ".repeat(column - length(first))}`
      : `  ${first}\n${" ".repeat(column + 2)}`;
    const wrapped = formatParagraphs(second, Math.max(HELP_WIDTH - column - 2, 10), "").split("\n");
    return prefix + wrapped.join("\n" + " ".repeat(column + 2));
  }).join("\n");
}
