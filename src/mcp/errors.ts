/** Only deliberately authored messages may reach MCP/logs, never raw OAuth bodies. */
export class ProxyError extends Error {}

export function safeError(error: unknown): string {
  return error instanceof ProxyError
    ? error.message
    : "Kagura connection or authentication failed. Check the server and OAuth profile; restart the extension to retry.";
}
