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
