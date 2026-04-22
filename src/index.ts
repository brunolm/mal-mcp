#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runAuthFlow } from "./auth.js";
import { MalClient } from "./mal-client.js";
import { FileStore } from "./storage.js";
import { registerAnimeTools } from "./tools/anime.js";
import { type AuthFlow, registerAuthTools } from "./tools/auth.js";
import { registerMangaTools } from "./tools/manga.js";
import { registerUserTools } from "./tools/user.js";

async function seedConfigFromEnv(client: MalClient): Promise<void> {
  if (await client.hasConfig()) return;
  const clientId = process.env.MAL_CLIENT_ID;
  if (!clientId) return;
  await client.setConfig({
    clientId,
    clientSecret: process.env.MAL_CLIENT_SECRET,
  });
}

class StdioAuthFlow implements AuthFlow {
  constructor(private readonly client: MalClient) {}

  async begin({
    port,
    openBrowser,
  }: {
    port?: number;
    openBrowser?: boolean;
  }): Promise<
    | {
        status: "authorized";
        authorization_url: string;
        expires_at: string;
      }
    | {
        status: "pending";
        authorization_url: string;
        message: string;
      }
  > {
    const config = await this.client.requireConfig();
    let authUrl = "";
    const tokens = await runAuthFlow({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      port,
      openBrowser: openBrowser ?? true,
      onAuthUrl: (url) => {
        authUrl = url;
      },
    });
    await this.client.setTokens(tokens);
    return {
      status: "authorized",
      authorization_url: authUrl,
      expires_at: new Date(tokens.expires_at).toISOString(),
    };
  }
}

async function main(): Promise<void> {
  const store = new FileStore();
  const client = new MalClient(store);
  await seedConfigFromEnv(client);

  const server = new McpServer({
    name: "mal-mcp",
    version: "0.1.0",
  });

  registerAuthTools(server, client, new StdioAuthFlow(client));
  registerAnimeTools(server, client);
  registerMangaTools(server, client);
  registerUserTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[mal-mcp] fatal:", err);
  process.exit(1);
});
