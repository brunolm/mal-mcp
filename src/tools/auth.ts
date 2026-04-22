import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MalClient } from "../mal-client.js";
import { run } from "./helpers.js";

export interface AuthFlow {
  begin(opts: { port?: number; openBrowser?: boolean }): Promise<AuthBeginResult>;
}

export type AuthBeginResult =
  | {
      status: "authorized";
      authorization_url: string;
      expires_at: string;
    }
  | {
      status: "pending";
      authorization_url: string;
      message: string;
    };

export function registerAuthTools(
  server: McpServer,
  client: MalClient,
  authFlow: AuthFlow,
): void {
  server.registerTool(
    "configure",
    {
      title: "Configure MyAnimeList Credentials",
      description:
        "Store your MyAnimeList API client credentials for this session. Required before any other tool. Create a client at https://myanimelist.net/apiconfig — App Type 'other' is fine; register the redirect URL advertised by `get_auth_status`.",
      inputSchema: {
        client_id: z
          .string()
          .min(1)
          .describe("MyAnimeList API client ID."),
        client_secret: z
          .string()
          .optional()
          .describe(
            "MyAnimeList API client secret. Omit for public PKCE-only clients.",
          ),
      },
    },
    async ({ client_id, client_secret }) =>
      run(async () => {
        await client.setConfig({
          clientId: client_id,
          clientSecret: client_secret,
        });
        return {
          configured: true,
          has_client_secret: Boolean(client_secret),
          storage: client.getStore().describe(),
        };
      }),
  );

  server.registerTool(
    "authenticate",
    {
      title: "Authenticate with MyAnimeList",
      description:
        "Start the MyAnimeList OAuth2 flow. On stdio deployments this opens a browser and waits for the local callback; on hosted deployments this returns an authorization URL for you to open manually — tokens are persisted to this session's storage when the MAL redirect completes.",
      inputSchema: {
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe(
            "stdio only: local callback port (default 8765 or MAL_AUTH_PORT). Ignored on hosted deployments.",
          ),
        open_browser: z
          .boolean()
          .optional()
          .describe(
            "stdio only: attempt to open the authorization URL automatically (default true).",
          ),
      },
    },
    async ({ port, open_browser }) =>
      run(() => authFlow.begin({ port, openBrowser: open_browser ?? true })),
  );

  server.registerTool(
    "get_auth_status",
    {
      title: "Get Auth Status",
      description:
        "Check whether client credentials are configured and whether a MyAnimeList user token is available for user-scoped tools.",
      inputSchema: {},
    },
    async () =>
      run(async () => ({
        configured: await client.hasConfig(),
        authenticated: await client.hasUserAuth(),
        storage: client.getStore().describe(),
      })),
  );
}
