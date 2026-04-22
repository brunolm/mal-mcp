/// <reference types="@cloudflare/workers-types" />
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  buildAuthUrl,
  exchangeCode,
  generatePkceMaterial,
} from "./auth.js";
import { MalClient } from "./mal-client.js";
import {
  type MalConfig,
  type OAuthTokens,
  WorkerMalStore,
} from "./storage.js";
import { registerAnimeTools } from "./tools/anime.js";
import { registerMangaTools } from "./tools/manga.js";
import { registerUserTools } from "./tools/user.js";
import { run } from "./tools/helpers.js";

export interface Env {
  MAL_SESSION: DurableObjectNamespace<MalSession>;
}

interface PendingAuth {
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const ROUTE_RE = /^\/u\/([a-f0-9]{32})\/(mcp|callback)\/?$/;

/**
 * Per-user Durable Object. Keyed by `idFromName("u:" + hash)` where `hash` is
 * the first 32 hex chars of `sha256("v1:" + clientId + ":" + (clientSecret ?? ""))`.
 * Stores the user's MAL API client config, OAuth tokens, and short-lived
 * pending-auth state (PKCE verifier per outstanding state).
 */
export class MalSession extends DurableObject<Env> {
  async getConfig(): Promise<MalConfig | undefined> {
    return await this.ctx.storage.get<MalConfig>("config");
  }

  async setConfig(config: MalConfig): Promise<void> {
    await this.ctx.storage.put("config", config);
  }

  async getTokens(): Promise<OAuthTokens | undefined> {
    return await this.ctx.storage.get<OAuthTokens>("tokens");
  }

  async setTokens(tokens: OAuthTokens): Promise<void> {
    await this.ctx.storage.put("tokens", tokens);
  }

  async clearTokens(): Promise<void> {
    await this.ctx.storage.delete("tokens");
  }

  async getPendingAuth(state: string): Promise<PendingAuth | undefined> {
    const pending = await this.ctx.storage.get<PendingAuth>(`pending:${state}`);
    if (!pending) return undefined;
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
      await this.ctx.storage.delete(`pending:${state}`);
      return undefined;
    }
    return pending;
  }

  async setPendingAuth(state: string, pending: PendingAuth): Promise<void> {
    await this.ctx.storage.put(`pending:${state}`, pending);
  }

  async deletePendingAuth(state: string): Promise<void> {
    await this.ctx.storage.delete(`pending:${state}`);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return landingPage();
    }

    const match = ROUTE_RE.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });

    const hash = match[1]!;
    const action = match[2]!;

    if (action === "mcp") return await handleMcp(request, env, hash);
    if (action === "callback") return await handleCallback(env, hash, url);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function getStub(env: Env, hash: string): DurableObjectStub<MalSession> {
  return env.MAL_SESSION.get(env.MAL_SESSION.idFromName(`u:${hash}`));
}

async function hashCredentials(
  clientId: string,
  clientSecret?: string,
): Promise<string> {
  const data = new TextEncoder().encode(
    `v1:${clientId}:${clientSecret ?? ""}`,
  );
  const buf = await crypto.subtle.digest("SHA-256", data);
  let hex = "";
  for (const b of new Uint8Array(buf)) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, 32);
}

async function handleMcp(
  request: Request,
  env: Env,
  hash: string,
): Promise<Response> {
  const origin = new URL(request.url).origin;
  const stub = getStub(env, hash);
  const store = new WorkerMalStore(stub);
  const client = new MalClient(store);

  const server = new McpServer({ name: "mal-mcp", version: "0.1.0" });
  registerWorkerAuthTools(server, client, env, hash, origin);
  registerAnimeTools(server, client);
  registerMangaTools(server, client);
  registerUserTools(server, client);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return await transport.handleRequest(request);
}

function registerWorkerAuthTools(
  server: McpServer,
  client: MalClient,
  env: Env,
  hash: string,
  origin: string,
): void {
  server.registerTool(
    "authenticate",
    {
      title: "Authenticate with MyAnimeList",
      description:
        `Authenticate with MyAnimeList. Provide the MAL API client_id (and client_secret if your MAL app was issued one) that this URL was derived from. ` +
        `Returns a MyAnimeList authorization URL — open it in a browser to complete sign-in. ` +
        `Tokens land in this session's storage when the redirect hits ${origin}/u/${hash}/callback.`,
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
        const computed = await hashCredentials(client_id, client_secret);
        if (computed !== hash) {
          throw new Error(
            `Credential hash does not match this URL. The URL for these credentials is ${origin}/u/${computed}/mcp — connect with that URL instead, or visit ${origin} to derive the correct URL.`,
          );
        }

        const config: MalConfig = {
          clientId: client_id,
          clientSecret: client_secret,
        };
        await client.setConfig(config);

        const { verifier, state } = generatePkceMaterial();
        const redirectUri = `${origin}/u/${hash}/callback`;
        const stub = getStub(env, hash);
        await stub.setPendingAuth(state, {
          verifier,
          redirectUri,
          createdAt: Date.now(),
        });

        const authorizationUrl = buildAuthUrl({
          clientId: client_id,
          redirectUri,
          state,
          codeChallenge: verifier,
        });

        return {
          status: "pending" as const,
          authorization_url: authorizationUrl,
          message:
            "Open authorization_url in a browser to authorize MyAnimeList. The redirect will land on this server's callback URL and persist tokens to your session.",
          callback_url: redirectUri,
          callback_url_note:
            "Make sure this exact URL is registered as an App Redirect URL on your MAL API client (https://myanimelist.net/apiconfig).",
        };
      }),
  );

  server.registerTool(
    "get_auth_status",
    {
      title: "Get Auth Status",
      description:
        "Check whether MAL credentials are stored for this session and whether a user access token is available for user-scoped tools.",
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

async function handleCallback(
  env: Env,
  hash: string,
  url: URL,
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return htmlResponse(
      `<h1>Authorization error</h1><p>${escapeHtml(error)}</p>`,
      400,
    );
  }
  if (!code || !state) {
    return htmlResponse(
      `<h1>Invalid callback</h1><p>Missing code or state.</p>`,
      400,
    );
  }

  const stub = getStub(env, hash);
  const pending = await stub.getPendingAuth(state);
  if (!pending) {
    return htmlResponse(
      `<h1>State expired</h1><p>The authorization attempt has expired or was already consumed. Call the <code>authenticate</code> tool again from your MCP client.</p>`,
      400,
    );
  }
  await stub.deletePendingAuth(state);

  const config = await stub.getConfig();
  if (!config) {
    return htmlResponse(
      `<h1>Missing config</h1><p>No MAL credentials are stored for this session. Call the <code>authenticate</code> tool again.</p>`,
      400,
    );
  }

  let tokens: OAuthTokens;
  try {
    tokens = await exchangeCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
    });
  } catch (err) {
    return htmlResponse(
      `<h1>Token exchange failed</h1><pre>${escapeHtml(
        (err as Error).message,
      )}</pre>`,
      500,
    );
  }

  await stub.setTokens(tokens);
  return htmlResponse(
    `<h1>mal-mcp authorized</h1><p>You can close this tab and return to your MCP client. User-scoped tools are now available.</p>`,
  );
}

function landingPage(): Response {
  const body = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>mal-mcp</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.55; color: #222; }
    h1 { margin-bottom: 0.25rem; }
    h2 { margin-top: 2rem; }
    code { background: #f4f4f4; padding: 0.15rem 0.35rem; border-radius: 3px; word-break: break-all; }
    pre { background: #f4f4f4; padding: 0.75rem; border-radius: 4px; overflow-x: auto; }
    label { display: block; margin: 0.85rem 0; }
    input { width: 100%; padding: 0.5rem; box-sizing: border-box; font-size: 1rem; font-family: inherit; }
    button { padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; }
    .out { margin-top: 1.5rem; padding: 1rem 1.25rem; background: #f7faf7; border-left: 3px solid #4a8; display: none; }
    .out.show { display: block; }
    small { color: #666; }
  </style>
</head>
<body>
  <h1>mal-mcp</h1>
  <p>Model Context Protocol server for MyAnimeList. Each user gets a private URL derived from a hash of their MAL API client credentials.</p>

  <h2>1. Create a MAL API client</h2>
  <p>Go to <a href="https://myanimelist.net/apiconfig" target="_blank" rel="noopener">myanimelist.net/apiconfig</a> and create a client (App Type: <em>other</em>). After deriving your URL below, paste the callback URL into your MAL API client's "App Redirect URL" field.</p>

  <h2>2. Derive your private URL</h2>
  <p>Hashing happens in your browser. Credentials are never sent to this server from this page.</p>
  <label>MAL Client ID
    <input id="cid" autocomplete="off" spellcheck="false">
  </label>
  <label>MAL Client Secret <small>(only if MAL issued one)</small>
    <input id="csec" type="password" autocomplete="off" spellcheck="false">
  </label>
  <button id="go">Derive URL</button>

  <div id="out" class="out">
    <p><strong>MCP server URL</strong> &mdash; add this to your MCP client config:</p>
    <p><code id="mcp"></code></p>
    <p><strong>MAL App Redirect URL</strong> &mdash; paste this into your MAL API client settings:</p>
    <p><code id="cb"></code></p>
    <p>Then in your MCP client, call the <code>authenticate</code> tool with the same credentials. You'll receive a MyAnimeList authorization URL &mdash; open it in a browser to complete sign-in.</p>
  </div>

  <h2>How it works</h2>
  <ul>
    <li>The hash <em>is</em> the URL bearer &mdash; treat your MCP URL like a secret.</li>
    <li>Knowing only the URL hash is not enough to call MAL on your behalf: the <code>authenticate</code> tool re-verifies your client_id and client_secret against the URL hash before storing anything.</li>
    <li>Per-user data lives in a Cloudflare Durable Object keyed by your URL hash. Different credentials → different DO → fully separate state.</li>
  </ul>

  <script>
    const enc = new TextEncoder();
    async function hashCreds(id, sec) {
      const buf = await crypto.subtle.digest("SHA-256", enc.encode("v1:" + id + ":" + (sec || "")));
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("").slice(0, 32);
    }
    document.getElementById("go").addEventListener("click", async function () {
      const id = document.getElementById("cid").value.trim();
      const sec = document.getElementById("csec").value.trim();
      if (!id) { alert("Client ID is required"); return; }
      const h = await hashCreds(id, sec);
      const origin = location.origin;
      document.getElementById("mcp").textContent = origin + "/u/" + h + "/mcp";
      document.getElementById("cb").textContent = origin + "/u/" + h + "/callback";
      document.getElementById("out").classList.add("show");
    });
  </script>
</body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><body style="font-family: system-ui; max-width: 40rem; margin: 3rem auto; padding: 0 1rem;">${html}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
