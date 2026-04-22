/// <reference types="@cloudflare/workers-types" />
import {
  type AuthRequest,
  type OAuthHelpers,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { buildAuthUrl, exchangeCode, generatePkceMaterial } from "./auth.js";
import { MalClient } from "./mal-client.js";
import { type MalConfig, type OAuthTokens, WorkerMalStore } from "./storage.js";
import { registerAnimeTools } from "./tools/anime.js";
import { run } from "./tools/helpers.js";
import { registerMangaTools } from "./tools/manga.js";
import { registerUserTools } from "./tools/user.js";

export interface Env {
  MAL_SESSION: DurableObjectNamespace<MalSession>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface GrantProps extends Record<string, unknown> {
  userHash: string;
}

interface PendingMalAuth {
  authReqUrl: string;
  malClientId: string;
  malClientSecret?: string;
  verifier: string;
  redirectUri: string;
}

const MAL_CALLBACK_PATH = "/mal/callback";
const MAL_STATE_PREFIX = "mal_state:";
const MAL_STATE_TTL_SECONDS = 10 * 60;

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
}

const apiHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp" && !url.pathname.startsWith("/mcp/")) {
      return new Response("Not found", { status: 404 });
    }

    const props = (ctx as ExecutionContext & { props: GrantProps }).props;
    if (!props?.userHash) {
      return new Response("Missing grant props", { status: 500 });
    }

    const stub = env.MAL_SESSION.get(
      env.MAL_SESSION.idFromName(`u:${props.userHash}`),
    );
    const store = new WorkerMalStore(stub);
    const client = new MalClient(store);

    const server = new McpServer({ name: "mal-mcp", version: "0.1.0" });
    registerStatusTool(server, client);
    registerAnimeTools(server, client);
    registerMangaTools(server, client);
    registerUserTools(server, client);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return await transport.handleRequest(request);
  },
};

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return landingPage(url.origin);
    }

    if (url.pathname === "/authorize") {
      if (request.method === "GET") {
        return await renderAuthorizeForm(request, env);
      }
      if (request.method === "POST") {
        return await startMalAuth(request, env, url.origin);
      }
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === MAL_CALLBACK_PATH) {
      return await finishMalAuth(env, url);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function renderAuthorizeForm(
  request: Request,
  env: Env,
): Promise<Response> {
  let authReq: AuthRequest;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    return htmlResponse(
      `<h1>Invalid authorization request</h1><pre>${escapeHtml(
        (err as Error).message,
      )}</pre>`,
      400,
    );
  }

  let clientName = authReq.clientId;
  try {
    const info = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
    if (info?.clientName) clientName = info.clientName;
  } catch {
    // fall through with clientId as label
  }

  const authReqUrl = request.url;
  return htmlResponse(authorizePage(clientName, authReqUrl));
}

async function startMalAuth(
  request: Request,
  env: Env,
  origin: string,
): Promise<Response> {
  const form = await request.formData();
  const authReqUrl = String(form.get("__authreq_url") ?? "");
  const malClientId = String(form.get("mal_client_id") ?? "").trim();
  const malClientSecret = String(form.get("mal_client_secret") ?? "").trim();

  if (!authReqUrl) {
    return htmlResponse("<h1>Missing authorization request</h1>", 400);
  }
  if (!malClientId) {
    return htmlResponse(
      '<h1>MAL Client ID is required</h1><p><a href="javascript:history.back()">Back</a></p>',
      400,
    );
  }

  // Validate the authReqUrl parses as an auth request we issued.
  try {
    await env.OAUTH_PROVIDER.parseAuthRequest(new Request(authReqUrl));
  } catch (err) {
    return htmlResponse(
      `<h1>Invalid authorization request</h1><pre>${escapeHtml(
        (err as Error).message,
      )}</pre>`,
      400,
    );
  }

  const { verifier, state } = generatePkceMaterial();
  const redirectUri = `${origin}${MAL_CALLBACK_PATH}`;

  const pending: PendingMalAuth = {
    authReqUrl,
    malClientId,
    malClientSecret: malClientSecret || undefined,
    verifier,
    redirectUri,
  };

  await env.OAUTH_KV.put(MAL_STATE_PREFIX + state, JSON.stringify(pending), {
    expirationTtl: MAL_STATE_TTL_SECONDS,
  });

  const malAuthUrl = buildAuthUrl({
    clientId: malClientId,
    redirectUri,
    state,
    codeChallenge: verifier,
  });

  return Response.redirect(malAuthUrl, 302);
}

async function finishMalAuth(env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return htmlResponse(
      `<h1>MyAnimeList rejected authorization</h1><p>${escapeHtml(error)}</p>`,
      400,
    );
  }
  if (!code || !state) {
    return htmlResponse(
      `<h1>Invalid callback</h1><p>Missing code or state.</p>`,
      400,
    );
  }

  const raw = await env.OAUTH_KV.get(MAL_STATE_PREFIX + state);
  if (!raw) {
    return htmlResponse(
      `<h1>State expired or unknown</h1><p>The authorization attempt has expired or was already consumed. Restart the connection from your MCP client.</p>`,
      400,
    );
  }
  await env.OAUTH_KV.delete(MAL_STATE_PREFIX + state);

  const pending = JSON.parse(raw) as PendingMalAuth;

  let authReq: AuthRequest;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(
      new Request(pending.authReqUrl),
    );
  } catch (err) {
    return htmlResponse(
      `<h1>Authorization request no longer valid</h1><pre>${escapeHtml(
        (err as Error).message,
      )}</pre>`,
      400,
    );
  }

  let tokens: OAuthTokens;
  try {
    tokens = await exchangeCode({
      clientId: pending.malClientId,
      clientSecret: pending.malClientSecret,
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
    });
  } catch (err) {
    return htmlResponse(
      `<h1>MAL token exchange failed</h1><pre>${escapeHtml(
        (err as Error).message,
      )}</pre>`,
      500,
    );
  }

  const userHash = await hashCredentials(
    pending.malClientId,
    pending.malClientSecret,
  );

  const stub = env.MAL_SESSION.get(env.MAL_SESSION.idFromName(`u:${userHash}`));
  await stub.setConfig({
    clientId: pending.malClientId,
    clientSecret: pending.malClientSecret,
  });
  await stub.setTokens(tokens);

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: userHash,
    scope: authReq.scope,
    props: { userHash } satisfies GrantProps,
    metadata: {},
  });

  return Response.redirect(redirectTo, 302);
}

async function hashCredentials(
  clientId: string,
  clientSecret?: string,
): Promise<string> {
  const data = new TextEncoder().encode(`v1:${clientId}:${clientSecret ?? ""}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  let hex = "";
  for (const b of new Uint8Array(buf)) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, 32);
}

function registerStatusTool(server: McpServer, client: MalClient): void {
  server.registerTool(
    "get_auth_status",
    {
      title: "Get Auth Status",
      description:
        "Check whether MAL credentials and a user access token are available for this session.",
      inputSchema: {},
    },
    async () =>
      run(async () => ({
        configured: await client.hasConfig(),
        authenticated: await client.hasUserAuth(),
        storage: client.getStore().describe(),
      })),
  );

  // Preserve the name for clients that look for it; points users at the right action.
  server.registerTool(
    "authenticate",
    {
      title: "Authenticate (already done)",
      description:
        "Authentication happens automatically when you connect this MCP server. If tools fail with 401, disconnect and re-add the MCP server in your client to re-authenticate.",
      inputSchema: {
        _noop: z.boolean().optional(),
      },
    },
    async () =>
      run(async () => ({
        status: "already_authenticated_via_mcp_oauth",
        configured: await client.hasConfig(),
        authenticated: await client.hasUserAuth(),
      })),
  );
}

function landingPage(origin: string): Response {
  const callbackUrl = `${origin}${MAL_CALLBACK_PATH}`;
  const mcpUrl = `${origin}/mcp`;
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
  </style>
</head>
<body>
  <h1>mal-mcp</h1>
  <p>Model Context Protocol server for MyAnimeList. One URL, one login; each user supplies their own MAL API client during sign-in.</p>

  <h2>1. Create a MAL API client</h2>
  <p>Go to <a href="https://myanimelist.net/apiconfig" target="_blank" rel="noopener">myanimelist.net/apiconfig</a> and create a client (App Type: <em>other</em>). Set the <strong>App Redirect URL</strong> to:</p>
  <pre><code>${escapeHtml(callbackUrl)}</code></pre>

  <h2>2. Add this MCP server to your client</h2>
  <p>Use this URL:</p>
  <pre><code>${escapeHtml(mcpUrl)}</code></pre>
  <p>For Claude Code:</p>
  <pre><code>claude mcp add --transport http mal ${escapeHtml(mcpUrl)}</code></pre>
  <p>Your MCP client will open a browser to complete OAuth. On the MCP authorize page you'll enter your MAL <em>client_id</em> (and <em>client_secret</em>, if MAL issued one). You'll then approve on MyAnimeList, and you'll be returned to your MCP client, signed in.</p>

  <h2>How it works</h2>
  <ul>
    <li>This server is an OAuth 2.1 authorization server for MCP. Every user gets their own grant.</li>
    <li>Your MAL API credentials are used to run a MAL OAuth flow <em>on your behalf</em>. They and the resulting MAL tokens are stored in a per-user Cloudflare Durable Object.</li>
    <li>Users with different MAL credentials get fully separate Durable Objects.</li>
  </ul>
</body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function authorizePage(clientName: string, authReqUrl: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authorize mal-mcp</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.55; color: #222; }
    h1 { margin-bottom: 0.25rem; }
    label { display: block; margin: 0.85rem 0; }
    input[type=text], input[type=password] { width: 100%; padding: 0.5rem; box-sizing: border-box; font-size: 1rem; font-family: inherit; }
    button { padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; }
    small { color: #666; }
    .note { background: #f7faf7; border-left: 3px solid #4a8; padding: 0.5rem 0.9rem; margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>Authorize mal-mcp</h1>
  <p><strong>${escapeHtml(clientName)}</strong> is requesting access to MyAnimeList on your behalf.</p>

  <div class="note">Enter the credentials from <em>your</em> MAL API client (<a href="https://myanimelist.net/apiconfig" target="_blank" rel="noopener">myanimelist.net/apiconfig</a>). Continuing redirects you to MyAnimeList to approve the request.</div>

  <form method="POST" action="/authorize">
    <input type="hidden" name="__authreq_url" value="${escapeHtml(authReqUrl)}">
    <label>MAL Client ID
      <input type="text" name="mal_client_id" autocomplete="off" spellcheck="false" autofocus required>
    </label>
    <label>MAL Client Secret
      <input type="password" name="mal_client_secret" autocomplete="off" spellcheck="false">
    </label>
    <button type="submit">Continue to MyAnimeList</button>
  </form>
</body>
</html>`;
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

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mal"],
});
