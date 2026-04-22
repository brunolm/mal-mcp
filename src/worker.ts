/// <reference types="@cloudflare/workers-types" />
import {
  type AuthRequest,
  type OAuthHelpers,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
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

export interface Env {
  MAL_SESSION: DurableObjectNamespace<MalSession>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface MalProps {
  malUserId: string;
  malUsername: string;
  [key: string]: unknown;
}

interface PendingMalAuth {
  oauthReqInfo: AuthRequest;
  verifier: string;
  redirectUri: string;
  malConfig: MalConfig;
  createdAt: number;
}

interface PendingAuthorizeForm {
  oauthReqInfo: AuthRequest;
  createdAt: number;
}

const PENDING_PREFIX = "mal_pending:";
const FORM_PREFIX = "mal_form:";
const PENDING_TTL_SECONDS = 600;

/**
 * Per-MAL-user Durable Object that stores one user's MAL API client credentials
 * and OAuth tokens. Keyed by the MAL numeric user id
 * (`idFromName(\`user:${malUserId}\`)`).
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
}

/**
 * MCP API handler. Reached only after the OAuthProvider has validated the
 * bearer token, so `this.ctx.props` is always populated.
 */
export class McpApiHandler extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx as unknown as { props: MalProps }).props;
    if (!props?.malUserId) {
      return new Response("Missing user props", { status: 500 });
    }

    const stub = this.env.MAL_SESSION.get(
      this.env.MAL_SESSION.idFromName(`user:${props.malUserId}`),
    );
    const store = new WorkerMalStore(stub);
    const client = new MalClient(store);

    const server = new McpServer({ name: "mal-mcp", version: "0.1.0" });
    registerAnimeTools(server, client);
    registerMangaTools(server, client);
    registerUserTools(server, client);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return await transport.handleRequest(request);
  }
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      if (request.method === "GET") return await renderAuthorizeForm(request, env);
      if (request.method === "POST") return await processAuthorizeForm(request, env);
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/mal-callback") {
      return await handleMalCallback(request, env);
    }
    if (url.pathname === "/" || url.pathname === "") {
      return landingPage(url.origin);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function renderAuthorizeForm(
  request: Request,
  env: Env,
): Promise<Response> {
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  if (!client) {
    return htmlResponse(`<h1>Unknown OAuth client</h1>`, 400);
  }

  const formToken = generatePkceMaterial().state;
  const pending: PendingAuthorizeForm = {
    oauthReqInfo,
    createdAt: Date.now(),
  };
  await env.OAUTH_KV.put(FORM_PREFIX + formToken, JSON.stringify(pending), {
    expirationTtl: PENDING_TTL_SECONDS,
  });

  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/mal-callback`;
  const clientName = client.clientName ?? oauthReqInfo.clientId;

  const body = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Sign in to mal-mcp</title></head>
<body style="font-family: system-ui; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5;">
  <h1>Sign in to mal-mcp</h1>
  <p><strong>${escapeHtml(clientName)}</strong> wants to access MyAnimeList on your behalf.</p>
  <p>This server doesn't ship with any MAL credentials of its own. Bring your own MAL API client — credentials are stored only in your private session and never shared with other users.</p>
  <h2 style="margin-top: 2rem;">First time? Create a MAL API client</h2>
  <ol>
    <li>Go to <a href="https://myanimelist.net/apiconfig" target="_blank" rel="noopener">myanimelist.net/apiconfig</a> and create a client (App Type: <em>other</em>).</li>
    <li>Set the App Redirect URL to:<br><code style="display: inline-block; background: #f4f4f4; padding: 0.2rem 0.4rem; border-radius: 3px;">${escapeHtml(redirectUri)}</code></li>
    <li>Paste the issued credentials below.</li>
  </ol>
  <form method="POST" action="/authorize" style="margin-top: 1.5rem;">
    <input type="hidden" name="form_token" value="${escapeHtml(formToken)}">
    <p>
      <label>MAL Client ID<br>
        <input name="client_id" required autocomplete="off" style="width: 100%; padding: 0.45rem; box-sizing: border-box;">
      </label>
    </p>
    <p>
      <label>MAL Client Secret <small>(only if your MAL app was issued one)</small><br>
        <input name="client_secret" type="password" autocomplete="off" style="width: 100%; padding: 0.45rem; box-sizing: border-box;">
      </label>
    </p>
    <button type="submit" style="padding: 0.55rem 1.1rem; font-size: 1rem;">Continue to MyAnimeList</button>
  </form>
</body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function processAuthorizeForm(
  request: Request,
  env: Env,
): Promise<Response> {
  const formData = await request.formData();
  const formToken = String(formData.get("form_token") ?? "");
  const clientId = String(formData.get("client_id") ?? "").trim();
  const clientSecretRaw = String(formData.get("client_secret") ?? "").trim();
  const clientSecret = clientSecretRaw === "" ? undefined : clientSecretRaw;

  if (!formToken || !clientId) {
    return htmlResponse(
      `<h1>Missing fields</h1><p>client_id is required.</p>`,
      400,
    );
  }

  const formJson = await env.OAUTH_KV.get(FORM_PREFIX + formToken);
  if (!formJson) {
    return htmlResponse(
      `<h1>Form expired</h1><p>The sign-in form expired. Start again from your MCP client.</p>`,
      400,
    );
  }
  await env.OAUTH_KV.delete(FORM_PREFIX + formToken);

  const { oauthReqInfo } = JSON.parse(formJson) as PendingAuthorizeForm;
  const malConfig: MalConfig = { clientId, clientSecret };

  const { verifier, state } = generatePkceMaterial();
  const redirectUri = `${new URL(request.url).origin}/mal-callback`;
  const malAuthUrl = buildAuthUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge: verifier,
  });

  const pending: PendingMalAuth = {
    oauthReqInfo,
    verifier,
    redirectUri,
    malConfig,
    createdAt: Date.now(),
  };
  await env.OAUTH_KV.put(PENDING_PREFIX + state, JSON.stringify(pending), {
    expirationTtl: PENDING_TTL_SECONDS,
  });

  return Response.redirect(malAuthUrl, 302);
}

async function handleMalCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
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
    return htmlResponse(`<h1>Invalid callback</h1><p>Missing code or state.</p>`, 400);
  }

  const pendingJson = await env.OAUTH_KV.get(PENDING_PREFIX + state);
  if (!pendingJson) {
    return htmlResponse(
      `<h1>State expired</h1><p>The authorization attempt has expired or was already consumed. Start again from your MCP client.</p>`,
      400,
    );
  }
  await env.OAUTH_KV.delete(PENDING_PREFIX + state);

  const pending = JSON.parse(pendingJson) as PendingMalAuth;

  let malTokens: OAuthTokens;
  try {
    malTokens = await exchangeCode({
      clientId: pending.malConfig.clientId,
      clientSecret: pending.malConfig.clientSecret,
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
    });
  } catch (err) {
    return htmlResponse(
      `<h1>Token exchange failed</h1><pre>${escapeHtml((err as Error).message)}</pre>`,
      500,
    );
  }

  // Identify the MAL user so we can key per-user storage by their MAL id.
  const userRes = await fetch("https://api.myanimelist.net/v2/users/@me", {
    headers: { Authorization: `Bearer ${malTokens.access_token}` },
  });
  if (!userRes.ok) {
    return htmlResponse(
      `<h1>Failed to fetch MAL user</h1><p>HTTP ${userRes.status}</p>`,
      500,
    );
  }
  const malUser = (await userRes.json()) as { id: number; name: string };
  const malUserId = String(malUser.id);
  const malUsername = malUser.name;

  const stub = env.MAL_SESSION.get(
    env.MAL_SESSION.idFromName(`user:${malUserId}`),
  );
  await stub.setConfig(pending.malConfig);
  await stub.setTokens(malTokens);

  const props: MalProps = { malUserId, malUsername };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.oauthReqInfo,
    userId: malUserId,
    metadata: { malUsername },
    scope: pending.oauthReqInfo.scope,
    props,
  });

  return Response.redirect(redirectTo, 302);
}

function landingPage(origin: string): Response {
  const body = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>mal-mcp</title></head>
<body style="font-family: system-ui; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5;">
<h1>mal-mcp</h1>
<p>Model Context Protocol server for MyAnimeList, hosted on Cloudflare Workers with OAuth.</p>
<h2>Connect</h2>
<ol>
<li>Add to your MCP client config:
<pre>"mal": {
  "url": "${origin}/mcp"
}</pre>
</li>
<li>The first time you call a tool your client opens a browser. You'll be asked for your MyAnimeList API client credentials (one-time setup; create at <a href="https://myanimelist.net/apiconfig">myanimelist.net/apiconfig</a> with redirect URL <code>${origin}/mal-callback</code>) and then walked through MAL sign-in.</li>
</ol>
<p>Auth metadata: <a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a></p>
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

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  // Between the MCP client and us — require S256 PKCE (OAuth 2.1 recommendation).
  // This is independent of MAL's upstream PKCE, which only supports "plain".
  allowPlainPKCE: false,
  accessTokenTTL: 3600,
  refreshTokenTTL: 30 * 24 * 3600,
});
