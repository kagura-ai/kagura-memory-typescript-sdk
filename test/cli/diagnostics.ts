/**
 * Diagnostic bodies for tests of validation and error precedence. Full terminal
 * framing (including Usage and Try) is covered by clickUsage.test.ts and the
 * Python dump tests; these assertions deliberately focus on the error itself.
 * Do not apply this to byte-for-byte terminal comparisons.
 */
export function diagnosticBody(text: string): string {
  return text.replace(/^Usage: [\s\S]*?\nTry '[^\n]+ --help' for help\.\n\n(?=Error: )/, "");
}

export function diagnosticBodies(lines: string): string;
export function diagnosticBodies(lines: readonly string[]): string[];
export function diagnosticBodies(lines: string | readonly string[]): string | string[] {
  return typeof lines === "string" ? diagnosticBody(lines) : lines.map(diagnosticBody);
}
