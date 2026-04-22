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

export interface MalStore {
  getConfig(): Promise<MalConfig | undefined>;
  setConfig(config: MalConfig): Promise<void>;
  clearConfig(): Promise<void>;

  getTokens(): Promise<OAuthTokens | undefined>;
  setTokens(tokens: OAuthTokens): Promise<void>;
  clearTokens(): Promise<void>;

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

  describe(): string {
    return `local files (${this.configPath}, ${this.tokenPath})`;
  }
}

/**
 * Serves a single request from config + tokens already loaded into memory
 * (typically from the OAuth grant props). Writes update the in-memory copy
 * so the rest of the current request sees refreshed tokens, but they do not
 * persist — grant-level persistence happens via `tokenExchangeCallback`.
 */
export class InMemoryMalStore implements MalStore {
  constructor(
    private config: MalConfig | undefined,
    private tokens: OAuthTokens | undefined,
  ) {}

  async getConfig(): Promise<MalConfig | undefined> {
    return this.config;
  }

  async setConfig(config: MalConfig): Promise<void> {
    this.config = config;
  }

  async clearConfig(): Promise<void> {
    this.config = undefined;
  }

  async getTokens(): Promise<OAuthTokens | undefined> {
    return this.tokens;
  }

  async setTokens(tokens: OAuthTokens): Promise<void> {
    this.tokens = tokens;
  }

  async clearTokens(): Promise<void> {
    this.tokens = undefined;
  }

  describe(): string {
    return "oauth grant props (in-memory)";
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
