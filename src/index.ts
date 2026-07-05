/** Kagura Memory SDK — memory management for Kagura Memory Cloud. */

export { KaguraClient, MIN_SERVER_VERSION } from "./client.js";
export type {
  CreateContextOptions,
  DeliveryMode,
  KaguraClientOptions,
  ListMemoriesOptions,
  ListTagsOptions,
  RecallOptions,
  RememberOptions,
  SearchMode,
  SetupResourceOptions,
  SourceType,
  ToolResult,
  UpdateContextOptions,
  UpdateMemoryOptions,
  UpdateSearchConfigOptions,
} from "./client.js";

export { loadConfig } from "./config.js";
export type { KaguraConfig, LoadConfigOptions } from "./config.js";

export {
  KaguraAuthDeniedError,
  KaguraAuthError,
  KaguraAuthExpiredError,
  KaguraConnectionError,
  KaguraContextError,
  KaguraError,
  KaguraFetchError,
  KaguraIngestError,
  KaguraIntegrityError,
  KaguraLLMError,
  KaguraNotFoundError,
  KaguraQuotaError,
  KaguraRateLimitError,
} from "./errors.js";

export { SDK_VERSION } from "./version.js";

export { DEFAULT_MCP_URL, resolveAuth } from "./auth/resolve.js";
export type { ResolveAuthOptions } from "./auth/resolve.js";
export type {
  AuthProvider,
  AuthSource,
  OAuthAuthResult,
  ResolvedAuth,
  StaticAuthResult,
  StaticSource,
} from "./auth/types.js";

export * from "./models.js";
