import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MalConfig {
  clientId: string;
  clientSecret?: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface PendingAuth {
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

export interface MalStore {
  getConfig(): Promise<MalConfig | undefined>;
  setConfig(config: MalConfig): Promise<void>;
  clearConfig(): Promise<void>;

  getTokens(): Promise<OAuthTokens | undefined>;
  setTokens(tokens: OAuthTokens): Promise<void>;
  clearTokens(): Promise<void>;

  getPendingAuth(stateKey: string): Promise<PendingAuth | undefined>;
  setPendingAuth(stateKey: string, pending: PendingAuth): Promise<void>;
  deletePendingAuth(stateKey: string): Promise<void>;

  describe(): string;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), ".mal-mcp-config.json");
export const DEFAULT_TOKEN_PATH = join(homedir(), ".mal-mcp-tokens.json");

export class FileStore implements MalStore {
  constructor(
    readonly configPath: string = DEFAULT_CONFIG_PATH,
    readonly tokenPath: string = DEFAULT_TOKEN_PATH,
  ) {}

  async getConfig(): Promise<MalConfig | undefined> {
    return readJson<MalConfig>(this.configPath);
  }

  async setConfig(config: MalConfig): Promise<void> {
    writeJson(this.configPath, config);
  }

  async clearConfig(): Promise<void> {
    if (existsSync(this.configPath)) unlinkSync(this.configPath);
  }

  async getTokens(): Promise<OAuthTokens | undefined> {
    return readJson<OAuthTokens>(this.tokenPath);
  }

  async setTokens(tokens: OAuthTokens): Promise<void> {
    writeJson(this.tokenPath, tokens);
  }

  async clearTokens(): Promise<void> {
    if (existsSync(this.tokenPath)) unlinkSync(this.tokenPath);
  }

  async getPendingAuth(): Promise<PendingAuth | undefined> {
    return undefined;
  }

  async setPendingAuth(): Promise<void> {}

  async deletePendingAuth(): Promise<void> {}

  describe(): string {
    return `local files (${this.configPath}, ${this.tokenPath})`;
  }
}

interface DurableObjectLikeStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class DurableObjectStore implements MalStore {
  private static readonly CONFIG_KEY = "config";
  private static readonly TOKENS_KEY = "tokens";
  private static readonly PENDING_PREFIX = "pending_auth:";
  private static readonly PENDING_TTL_MS = 10 * 60 * 1000;

  constructor(private readonly storage: DurableObjectLikeStorage) {}

  getConfig(): Promise<MalConfig | undefined> {
    return this.storage.get<MalConfig>(DurableObjectStore.CONFIG_KEY);
  }

  async setConfig(config: MalConfig): Promise<void> {
    await this.storage.put(DurableObjectStore.CONFIG_KEY, config);
  }

  async clearConfig(): Promise<void> {
    await this.storage.delete(DurableObjectStore.CONFIG_KEY);
  }

  getTokens(): Promise<OAuthTokens | undefined> {
    return this.storage.get<OAuthTokens>(DurableObjectStore.TOKENS_KEY);
  }

  async setTokens(tokens: OAuthTokens): Promise<void> {
    await this.storage.put(DurableObjectStore.TOKENS_KEY, tokens);
  }

  async clearTokens(): Promise<void> {
    await this.storage.delete(DurableObjectStore.TOKENS_KEY);
  }

  async getPendingAuth(stateKey: string): Promise<PendingAuth | undefined> {
    const pending = await this.storage.get<PendingAuth>(
      DurableObjectStore.PENDING_PREFIX + stateKey,
    );
    if (!pending) return undefined;
    if (Date.now() - pending.createdAt > DurableObjectStore.PENDING_TTL_MS) {
      await this.deletePendingAuth(stateKey);
      return undefined;
    }
    return pending;
  }

  async setPendingAuth(stateKey: string, pending: PendingAuth): Promise<void> {
    await this.storage.put(DurableObjectStore.PENDING_PREFIX + stateKey, pending);
  }

  async deletePendingAuth(stateKey: string): Promise<void> {
    await this.storage.delete(DurableObjectStore.PENDING_PREFIX + stateKey);
  }

  describe(): string {
    return "durable object storage";
  }
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}
