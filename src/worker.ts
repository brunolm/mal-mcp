/// <reference types="@cloudflare/workers-types" />
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildAuthUrl, exchangeCode, generatePkceMaterial } from "./auth.js";
import { MalClient } from "./mal-client.js";
import { DurableObjectStore, type MalStore } from "./storage.js";
import { registerAnimeTools } from "./tools/anime.js";
import {
  type AuthBeginResult,
  type AuthFlow,
  registerAuthTools,
} from "./tools/auth.js";
import { registerMangaTools } from "./tools/manga.js";
import { registerUserTools } from "./tools/user.js";

export interface Env {
  MAL_SESSION: DurableObjectNamespace;
}

const USER_ID_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

class WorkerAuthFlow implements AuthFlow {
  constructor(
    private readonly client: MalClient,
    private readonly store: MalStore,
    private readonly userId: string,
    private readonly workerOrigin: string,
  ) {}

  async begin(): Promise<AuthBeginResult> {
    const config = await this.client.requireConfig();
    const { verifier, state: stateKey } = generatePkceMaterial();
    const redirectUri = `${this.workerOrigin}/callback`;
    const state = `${this.userId}:${stateKey}`;
    const authorizationUrl = buildAuthUrl({
      clientId: config.clientId,
      redirectUri,
      state,
      codeChallenge: verifier,
    });
    await this.store.setPendingAuth(stateKey, {
      verifier,
      redirectUri,
      createdAt: Date.now(),
    });
    return {
      status: "pending",
      authorization_url: authorizationUrl,
      message: `Open the authorization_url in your browser. Make sure ${redirectUri} is registered as an App Redirect URL on your MAL API client — tokens will be saved to this session when MyAnimeList redirects back.`,
    };
  }
}

export class MalSession implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/callback") {
      return await this.handleCallback(url);
    }

    const userMatch = url.pathname.match(/^\/u\/([^/]+)\/mcp\/?$/);
    if (userMatch && userMatch[1]) {
      return await this.handleMcp(request, userMatch[1], url.origin);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleMcp(
    request: Request,
    userId: string,
    origin: string,
  ): Promise<Response> {
    const store = new DurableObjectStore(this.ctx.storage);
    const client = new MalClient(store);
    const authFlow = new WorkerAuthFlow(client, store, userId, origin);

    const server = new McpServer({ name: "mal-mcp", version: "0.1.0" });
    registerAuthTools(server, client, authFlow);
    registerAnimeTools(server, client);
    registerMangaTools(server, client);
    registerUserTools(server, client);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    return await transport.handleRequest(request);
  }

  private async handleCallback(url: URL): Promise<Response> {
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
    const [, stateKey] = state.split(":", 2);
    if (!stateKey) {
      return htmlResponse(`<h1>Invalid state</h1>`, 400);
    }

    const store = new DurableObjectStore(this.ctx.storage);
    const pending = await store.getPendingAuth(stateKey);
    if (!pending) {
      return htmlResponse(
        `<h1>No pending authorization</h1><p>This state has already been consumed or has expired. Call <code>authenticate</code> again.</p>`,
        400,
      );
    }

    const config = await store.getConfig();
    if (!config) {
      return htmlResponse(
        `<h1>Not configured</h1><p>This session has no MAL client credentials. Call <code>configure</code> first.</p>`,
        400,
      );
    }

    try {
      const tokens = await exchangeCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        codeVerifier: pending.verifier,
        redirectUri: pending.redirectUri,
      });
      await store.setTokens(tokens);
      await store.deletePendingAuth(stateKey);
      return htmlResponse(
        `<h1>mal-mcp authorized</h1><p>You can close this tab and return to your MCP client.</p>`,
      );
    } catch (err) {
      return htmlResponse(
        `<h1>Token exchange failed</h1><pre>${escapeHtml(
          (err as Error).message,
        )}</pre>`,
        500,
      );
    }
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return landingPage(url.origin);
    }

    if (url.pathname === "/callback") {
      const state = url.searchParams.get("state");
      const userId = (state ?? "").split(":", 2)[0];
      if (!userId || !USER_ID_REGEX.test(userId)) {
        return htmlResponse(`<h1>Invalid state</h1>`, 400);
      }
      return forwardToSession(env, userId, request);
    }

    const userMatch = url.pathname.match(/^\/u\/([^/]+)\/mcp\/?$/);
    if (userMatch && userMatch[1]) {
      const userId = userMatch[1];
      if (!USER_ID_REGEX.test(userId)) {
        return new Response(
          "Invalid user id: must be 8-128 chars of A-Z, a-z, 0-9, _ or -",
          { status: 400 },
        );
      }
      return forwardToSession(env, userId, request);
    }

    return new Response("Not found", { status: 404 });
  },
};

export default worker;

function forwardToSession(
  env: Env,
  userId: string,
  request: Request,
): Promise<Response> {
  const id = env.MAL_SESSION.idFromName(userId);
  const stub = env.MAL_SESSION.get(id);
  return stub.fetch(request);
}

function landingPage(origin: string): Response {
  const body = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>mal-mcp</title></head>
<body style="font-family: system-ui; max-width: 42rem; margin: 3rem auto; padding: 0 1rem;">
<h1>mal-mcp</h1>
<p>Model Context Protocol server for MyAnimeList, hosted on Cloudflare Workers.</p>
<h2>Connect</h2>
<ol>
<li>Generate a random user ID (UUID is fine).</li>
<li>Add to your MCP client config:
<pre>"mal": {
  "url": "${origin}/u/&lt;your-user-id&gt;/mcp"
}</pre>
</li>
<li>From your client, call <code>configure</code> with your MAL <code>client_id</code> (and <code>client_secret</code> if issued), then <code>authenticate</code>.</li>
<li>Register <code>${origin}/callback</code> as the App Redirect URL on your <a href="https://myanimelist.net/apiconfig">MAL API client</a>.</li>
</ol>
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
