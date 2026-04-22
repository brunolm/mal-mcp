# mal-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the [MyAnimeList v2 API](https://myanimelist.net/apiconfig/references/api/v2) to Claude and other MCP-compatible clients. Written in TypeScript, runs locally via [Bun](https://bun.com) over stdio or deploys to [Cloudflare Workers](https://developers.cloudflare.com/workers/) as a hosted multi-user server.

## Tools

### Setup
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

## Option 2: Host on Cloudflare Workers (multi-user)

This deploys a single Worker that every user can connect to. Each user gets their own isolated state — credentials, tokens, and OAuth flow — stored in a [Durable Object](https://developers.cloudflare.com/durable-objects/) keyed by a URL-path user ID.

### 1. Install and deploy

```powershell
bun install
bunx wrangler login
bun run worker:deploy
```

Wrangler prints the deployed URL, e.g. `https://mal-mcp.<account>.workers.dev`.

To run locally while developing:

```powershell
bun run worker:dev
```

### 2. Each user sets up their own connection

Every user of the hosted server follows these steps:

1. **Generate a user ID.** Any hard-to-guess string, 8–128 chars of `A-Z a-z 0-9 _ -`. A UUID is perfect:
   ```powershell
   [guid]::NewGuid().ToString("N")
   ```
2. **Add the MCP server** to their client config using a URL that embeds the user ID:
   ```json
   {
     "mcpServers": {
       "mal": {
         "url": "https://mal-mcp.<account>.workers.dev/u/<your-user-id>/mcp"
       }
     }
   }
   ```
3. **Create a MAL API client** at <https://myanimelist.net/apiconfig>:
   - **App Type:** other / web
   - **App Redirect URL:** `https://mal-mcp.<account>.workers.dev/callback` (the Worker origin)
4. **Call `configure`** from the MCP client with the MAL `client_id` (and `client_secret` if issued).
5. **Call `authenticate`** from the MCP client. It returns an authorization URL the user opens in a browser. MAL redirects to the Worker's `/callback`, which persists tokens to the user's Durable Object.

### Security notes for hosted deployments

- The user ID in the URL path **is the secret that scopes access to a user's stored tokens**. Treat it like a credential — don't share it. Anyone with the URL can call tools as that user.
- Hosting the server publicly exposes it to the internet. Consider adding a custom domain with [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) or another authentication layer if you want to restrict who can connect at all.
- The `callback` URL is public and shared across users; it only accepts requests with a valid MAL-issued authorization code and state, and the state encodes the user ID so tokens land in the correct Durable Object.

## Environment variables (stdio only)

| Variable | Required | Purpose |
| --- | --- | --- |
| `MAL_CLIENT_ID` | no | Seeds the stdio config store on first boot if nothing is saved yet. |
| `MAL_CLIENT_SECRET` | no | Same, for clients that were issued a secret. |
| `MAL_AUTH_PORT` | no | Port the one-shot OAuth callback listens on (default `8765`). |

On hosted Worker deployments, env vars are **not** used; every user supplies their own credentials via the `configure` tool.

## Development

```powershell
bun run dev              # stdio, watch mode
bun run worker:dev       # Worker, local (miniflare)
bun run typecheck        # tsc --noEmit
```

All tools take an optional `fields` string that passes straight through to MAL — see the [field spec](https://myanimelist.net/apiconfig/references/api/v2#section/Common-formats) if you need to override the defaults.
