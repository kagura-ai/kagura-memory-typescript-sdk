/** Kagura Memory SDK — memory management for Kagura Memory Cloud. */

export { KaguraClient, MIN_SERVER_VERSION } from "./client.js";
export type {
  AgentBindingScopeOptions,
  AgentEnforcementMode,
  AgentStatus,
  AgentWritePolicy,
  BindAgentContextOptions,
  CreateContextOptions,
  DeliveryMode,
  KaguraClientOptions,
  ListMemoriesOptions,
  ListTagsOptions,
  RecallOptions,
  RegisterAgentOptions,
  RememberOptions,
  SearchMode,
  SetupResourceOptions,
  SourceType,
  ToolResult,
  UpdateAgentBindingOptions,
  UpdateAgentOptions,
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

export {
  DEFAULT_REST_BASE_URL,
  KaguraRestClient,
} from "./restBase.js";
export type {
  FromMcpUrlOptions,
  HttpMethod,
  KaguraRestClientOptions,
} from "./restBase.js";

export type { GetAgentBootstrapOptions } from "./agentBootstrap.js";
export { AgentsClient } from "./agentsClient.js";

export { FilesClient } from "./filesClient.js";
export type { FilesClientOptions, UploadOptions } from "./filesClient.js";

export {
  ResourceClient,
  SETUP_OAUTH_NOT_SUPPORTED_MSG,
} from "./resourceClient.js";
export type {
  CreateTokenOptions,
  ListResourceEventsOptions,
  ListTokensOptions,
  ResourceEventInput,
  ResourceSetupOptions,
  UpdateTokenOptions,
} from "./resourceClient.js";

export {
  VALID_ASSIGNABLE_ROLES,
  VALID_INVITE_EXPIRES,
  WorkspaceClient,
} from "./workspaceClient.js";
export type {
  CreateInvitationOptions,
  ListInvitationsOptions,
} from "./workspaceClient.js";

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
