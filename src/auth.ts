import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthTokens } from "./storage.js";

export const AUTH_BASE = "https://myanimelist.net/v1/oauth2";

export interface BuildAuthUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export function buildAuthUrl(opts: BuildAuthUrlOptions): string {
  const url = new URL(`${AUTH_BASE}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  // MAL PKCE supports only the "plain" method — code_challenge == code_verifier.
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "plain");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  return url.toString();
}

export interface PkceMaterial {
  verifier: string;
  state: string;
}

export function generatePkceMaterial(): PkceMaterial {
  return {
    verifier: randomBytes(64).toString("base64url"),
    state: randomBytes(16).toString("base64url"),
  };
}

export interface ExchangeCodeOptions {
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export async function exchangeCode(opts: ExchangeCodeOptions): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    grant_type: "authorization_code",
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
  });
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MAL token exchange failed (${res.status}): ${text}`);
  }
  const data = JSON.parse(text) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export interface RefreshAccessTokenOptions {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

export async function refreshAccessToken(
  opts: RefreshAccessTokenOptions,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`MAL refresh failed (${res.status})`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

// ---- stdio-only helpers (Node http listener) ----

export interface RunAuthFlowOptions {
  clientId: string;
  clientSecret?: string;
  port?: number;
  openBrowser?: boolean;
  onAuthUrl?: (url: string) => void;
  timeoutMs?: number;
}

export async function runAuthFlow(opts: RunAuthFlowOptions): Promise<OAuthTokens> {
  const {
    clientId,
    clientSecret,
    port = Number(process.env.MAL_AUTH_PORT ?? 8765),
    openBrowser = true,
    onAuthUrl,
    timeoutMs = 5 * 60_000,
  } = opts;

  const redirectUri = `http://localhost:${port}/callback`;
  const { verifier, state } = generatePkceMaterial();
  const authUrl = buildAuthUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge: verifier,
  });

  onAuthUrl?.(authUrl);

  return await new Promise<OAuthTokens>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (!req.url || !req.url.startsWith("/callback")) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.statusCode = 400;
        res.end(`Authorization error: ${error}`);
        cleanup();
        reject(new Error(`Authorization error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.statusCode = 400;
        res.end("Invalid callback (missing code or state mismatch).");
        return;
      }

      try {
        const tokens = await exchangeCode({
          clientId,
          clientSecret,
          code,
          codeVerifier: verifier,
          redirectUri,
        });

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<h1>mal-mcp authorized</h1><p>You can close this tab and return to your client.</p>",
        );

        cleanup();
        resolve(tokens);
      } catch (err) {
        res.statusCode = 500;
        res.end(`Error: ${(err as Error).message}`);
        cleanup();
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for MAL authorization callback on ${redirectUri} after ${Math.round(
            timeoutMs / 1000,
          )}s.`,
        ),
      );
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });

    server.listen(port, () => {
      if (!openBrowser) return;
      const platform = process.platform;
      const cmd =
        platform === "win32"
          ? `start "" "${authUrl}"`
          : platform === "darwin"
            ? `open "${authUrl}"`
            : `xdg-open "${authUrl}"`;
      exec(cmd, () => {
        // best-effort: user can paste manually if this fails
      });
    });
  });
}
