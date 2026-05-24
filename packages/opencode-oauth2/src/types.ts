export interface RawModel {
  id: string;
  [key: string]: unknown;
}

export interface NormalizedModel {
  id: string;
  displayName: string;
}

export interface ModelDiff {
  added: string[];
  removed: string[];
  renamed: Array<{
    id: string;
    before: string;
    after: string;
  }>;
}

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  // Absent for grants that don't issue refresh tokens (e.g. client_credentials,
  // where re-authentication is just another machine-to-machine POST).
  refreshToken?: string;
  scope?: string;
  expiresAt?: number;
}

export interface CachedServerState {
  serverId: string;
  updatedAt: number;
  lastSyncAt?: number;
  models: NormalizedModel[];
  rawModels: RawModel[];
  token?: TokenSet;
}

export interface ServerSnapshot {
  serverId: string;
  models: NormalizedModel[];
  lastSyncAt?: number;
}
