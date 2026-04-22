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

/**
 * Per-MAL-user store backed by a `MalSession` Durable Object stub.
 * Config and tokens both live in the DO (each user supplies their own MAL API
 * client during sign-in). Pending-auth methods are unused on the worker — the
 * OAuth dance state is handled separately, in worker.ts, via OAUTH_KV.
 */
interface MalSessionStub {
  getConfig(): Promise<MalConfig | undefined>;
  setConfig(config: MalConfig): Promise<void>;
  getTokens(): Promise<OAuthTokens | undefined>;
  setTokens(tokens: OAuthTokens): Promise<void>;
  clearTokens(): Promise<void>;
}

export class WorkerMalStore implements MalStore {
  constructor(private readonly stub: MalSessionStub) {}

  getConfig(): Promise<MalConfig | undefined> {
    return this.stub.getConfig();
  }

  async setConfig(config: MalConfig): Promise<void> {
    await this.stub.setConfig(config);
  }

  async clearConfig(): Promise<void> {
    // not exposed: config is rewritten on every successful sign-in
  }

  getTokens(): Promise<OAuthTokens | undefined> {
    return this.stub.getTokens();
  }

  async setTokens(tokens: OAuthTokens): Promise<void> {
    await this.stub.setTokens(tokens);
  }

  async clearTokens(): Promise<void> {
    await this.stub.clearTokens();
  }

  async getPendingAuth(): Promise<PendingAuth | undefined> {
    return undefined;
  }

  async setPendingAuth(): Promise<void> {}

  async deletePendingAuth(): Promise<void> {}

  describe(): string {
    return "cloudflare durable object (per MAL user)";
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
