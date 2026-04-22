# mal-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the [MyAnimeList v2 API](https://myanimelist.net/apiconfig/references/api/v2) to Claude and other MCP-compatible clients. Written in TypeScript, runs locally via [Bun](https://bun.com) over stdio or deploys to [Cloudflare Workers](https://developers.cloudflare.com/workers/) as a hosted multi-user server.

## Tools

### Setup (stdio only)

On hosted Worker deployments these tools are not registered — sign-in happens through the Worker's OAuth flow when your MCP client first connects.

- `configure` — store the user's MyAnimeList `client_id` (and `client_secret` if issued). Must be called before any other tool.
- `authenticate` — start the MAL OAuth flow.
- `get_auth_status` — check whether credentials and user tokens are available.

### Public (Client ID only)

- `search_anime` — search anime by title
- `get_anime_details` — full details for an anime ID
- `get_anime_ranking` — ranked lists (all, airing, upcoming, tv, ova, movie, special, bypopularity, favorite)
- `get_seasonal_anime` — anime by year + season
- `search_manga` — search manga by title
- `get_manga_details` — full details for a manga ID
- `get_manga_ranking` — ranked lists (all, manga, novels, oneshots, doujin, manhwa, manhua, bypopularity, favorite)

### User-scoped (OAuth2 access token required)

- `get_current_user` — profile + anime statistics for the authenticated user
- `get_anime_suggestions` — personalized anime recommendations
- `get_user_anime_list` — read any user's public anime list (or `@me`)
- `update_anime_list_status` — add / update list status, score, episodes watched, etc.
- `delete_anime_list_item` — remove an anime from your list
- `get_user_manga_list` — read any user's public manga list (or `@me`)
- `update_manga_list_status` — add / update list status, score, chapters read, etc.
- `delete_manga_list_item` — remove a manga from your list

## Option 1: Run locally over stdio

### 1. Install

```powershell
bun install
```

### 2. Wire it up to your MCP client

Add to `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mal": {
      "command": "bun",
      "args": ["C:\\BrunoLM\\Projects\\mal-mcp\\src\\index.ts"]
    }
  }
}
```

For Claude Code, use `claude mcp add` or drop the equivalent block into `.claude/mcp.json`.

### 3. Configure your MAL credentials

Create an API client at <https://myanimelist.net/apiconfig>:

- **App Type:** other / web
- **App Redirect URL:** `http://localhost:8765/callback`

Then, from your MCP client, call the `configure` tool with your `client_id` (and `client_secret` if MAL issued one). Credentials are persisted to `~/.mal-mcp-config.json`.

### 4. (Optional) Authorize for user-scoped tools

Call `authenticate` from your MCP client. A browser opens, you approve the request, the local server on port 8765 catches the redirect, and tokens land in `~/.mal-mcp-tokens.json`. The server refreshes them automatically from there.

If you prefer a CLI:

```powershell
$env:MAL_CLIENT_ID = "your-client-id"
# $env:MAL_CLIENT_SECRET = "your-client-secret"   # only if issued
bun run auth
```

## Option 2: Host on Cloudflare Workers (multi-user, OAuth)

A single Worker serves every user. The Worker is an MCP OAuth resource server — your MCP client discovers OAuth metadata, registers itself dynamically, and walks the user through MyAnimeList sign-in. The Worker has no MAL credentials of its own; each user supplies their own MAL API client during sign-in. Identity is bound to the MyAnimeList numeric user id; short-lived access tokens (issued by the Worker) are revocable per-grant.

### 1. Operator setup (once)

```powershell
bun install
bunx wrangler login

# KV namespace used by the OAuth provider for client/grant/token state
bunx wrangler kv namespace create OAUTH_KV
# Paste the printed id into wrangler.jsonc under kv_namespaces[0].id

bun run worker:deploy
```

For local development:

```powershell
bun run worker:dev
```

No secrets to set — the Worker is BYO-MAL-credentials.

### 2. Each user connects

Add the server to your MCP client:

```json
{
  "mcpServers": {
    "mal": {
      "url": "https://mal-mcp.<account>.workers.dev/mcp"
    }
  }
}
```

First connection flow:

1. Your MCP client opens a browser to `/authorize`.
2. The Worker shows a one-time form asking for your MAL `client_id` (and `client_secret` if your MAL app has one).
   - If you don't have a MAL API client yet: create one at <https://myanimelist.net/apiconfig> (App Type: _other_) with the App Redirect URL set to `https://mal-mcp.<account>.workers.dev/mal-callback`.
3. The Worker redirects to MyAnimeList for sign-in.
4. On return the Worker stores your MAL credentials and tokens in your private Durable Object (keyed by your MAL user id), then issues an OAuth access token to your MCP client.

Subsequent tool calls just use the token. If the token is later revoked or the refresh token expires, you'll be sent through the form again.

### Security notes for hosted deployments

- Access tokens are short-lived (1 hour by default) and refreshable; refresh tokens expire after 30 days. Both are revocable per-grant.
- MAL credentials and tokens never leave the Worker — only an opaque Worker-issued bearer token rides on each MCP request.
- Token props are encrypted at rest by [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) using the secret token as key material.
- The Worker is publicly reachable. Anyone can attempt the sign-in flow, but they only ever get access to _their own_ MAL account, using _their own_ MAL API client.

## Environment variables (stdio only)

| Variable            | Required | Purpose                                                             |
| ------------------- | -------- | ------------------------------------------------------------------- |
| `MAL_CLIENT_ID`     | no       | Seeds the stdio config store on first boot if nothing is saved yet. |
| `MAL_CLIENT_SECRET` | no       | Same, for clients that were issued a secret.                        |
| `MAL_AUTH_PORT`     | no       | Port the one-shot OAuth callback listens on (default `8765`).       |

On hosted Worker deployments these env vars are not used; each end user supplies their own MAL credentials through the Worker's OAuth sign-in form.

## Development

```powershell
bun run dev              # stdio, watch mode
bun run worker:dev       # Worker, local (miniflare)
bun run typecheck        # tsc --noEmit
```

All tools take an optional `fields` string that passes straight through to MAL — see the [field spec](https://myanimelist.net/apiconfig/references/api/v2#section/Common-formats) if you need to override the defaults.
