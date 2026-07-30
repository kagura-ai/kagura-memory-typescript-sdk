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
  KaguraCryptoError,
  KaguraKeyCustodyError,
  KaguraSecretError,
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

// Zero-knowledge secret store (#28). SecretClient is the fourth REST client,
// the peer of Files/Resource/Workspace that was never ported. The crypto
// module needs the optional `age-encryption` peer dependency; everything
// else here — the client, the wire types, the fingerprint and armor helpers
// — works on a bare install.
export { SecretClient } from "./secrets/client.js";
export {
  armorDecode,
  armorEncode,
  decrypt,
  encrypt,
  fingerprint,
  generateKeypair,
  recipientFromIdentity,
  MAX_CIPHERTEXT_BYTES,
  RECIPIENT_RE,
} from "./secrets/crypto.js";
export { KeyManager } from "./secrets/keyManager.js";
export type { KeyManagerOptions, KeyStore } from "./secrets/keyManager.js";

export { DEFAULT_MCP_URL, resolveAuth } from "./auth/resolve.js";
export type { ResolveAuthOptions } from "./auth/resolve.js";

// Interactive login (#9) — obtaining credentials, not just reading and
// refreshing them. `login()` is the one-call path; the RFC 8628 primitives
// and the credentials store are exported too so a host app can drive the
// flow itself (e.g. its own polling UI) or manage profiles.
export { DEFAULT_SCOPE, READ_ONLY_SCOPE, login } from "./auth/login.js";
export type { LoginOptions } from "./auth/login.js";

export { refresh } from "./auth/refresh.js";
export type { RefreshOptions } from "./auth/refresh.js";

export {
  authorizeDevice,
  pollForToken,
  refreshAccessToken,
  revokeToken,
  DEFAULT_CLIENT_ID,
  DEVICE_FLOW_GRANT_TYPE,
  REFRESH_TOKEN_GRANT_TYPE,
} from "./auth/deviceFlow.js";
export type {
  DeviceAuthorizationResponse,
  OAuthHttpOptions,
  PollForTokenOptions,
  RefreshAccessTokenOptions,
  TokenResponse,
} from "./auth/deviceFlow.js";

export {
  defaultCredentialsPath,
  deleteCredentialsFile,
  deleteProfile,
  emptyCredentialsFile,
  getProfile,
  isExpired,
  loadCredentialsFile,
  removeProfile,
  saveCredentialsFile,
  setDefaultProfile,
  setProfile,
  updateProfile,
  // Rotation primitives (#16): KaguraOAuth is what actually refreshes and
  // persists under the cross-process lock, so a caller holding its own
  // provider — a proxy recovering from an upstream 401, say — needs it.
  KaguraOAuth,
  withRefreshed,
  REFRESH_SKEW_SEC,
} from "./auth/credentials.js";
export type {
  CredentialsFile,
  OAuthCredentials,
  SharedCredentialsState,
} from "./auth/credentials.js";
export type {
  AuthProvider,
  AuthSource,
  OAuthAuthResult,
  ResolvedAuth,
  StaticAuthResult,
  StaticSource,
} from "./auth/types.js";

export * from "./models.js";
