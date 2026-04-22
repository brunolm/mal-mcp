# mal-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the [MyAnimeList v2 API](https://myanimelist.net/apiconfig/references/api/v2) to Claude and other MCP-compatible clients. Written in TypeScript, runs locally via [Bun](https://bun.com) over stdio or deploys to [Cloudflare Workers](https://developers.cloudflare.com/workers/) as a hosted multi-user server.

## Tools

### Setup

- `configure` — **stdio only** — store the user's MyAnimeList `client_id` (and `client_secret` if issued). Must be called before any other tool. Not registered on the Worker; on the Worker, credentials come in through `authenticate`.
- `authenticate` — start the MAL OAuth flow. On stdio, opens a browser and waits for the local callback. On the Worker, takes `client_id` (and optional `client_secret`) and returns a MAL authorization URL to open manually.
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

## Option 2: Host on Cloudflare Workers (multi-user, hash-derived URLs)

A single Worker serves every user. Each user gets a private MCP URL of the form `https://mal-mcp.<account>.workers.dev/u/<hash>/mcp`, where `<hash>` is the first 32 hex chars of `sha256("v1:" + client_id + ":" + (client_secret ?? ""))`. Per-user state (MAL credentials + OAuth tokens) lives in a Durable Object keyed by that hash. No KV namespace, no OAuth provider library, no operator-side MAL credentials.

### 1. Operator setup (once)

```powershell
bun install
bunx wrangler login
bun run worker:deploy
```

For local development:

```powershell
bun run worker:dev
```

### 2. Each user connects

1. Open `https://mal-mcp.<account>.workers.dev/` in a browser. Paste your MAL `client_id` (and `client_secret` if MAL issued one) — hashing happens locally in the browser. The page returns:
   - your MCP server URL (`/u/<hash>/mcp`), and
   - the App Redirect URL to register on your MAL API client (`/u/<hash>/callback`).

   If you don't have a MAL API client yet: create one at <https://myanimelist.net/apiconfig> (App Type: _other_) and paste the callback URL into "App Redirect URL".

2. Add the MCP server to your client config:

   ```json
   {
     "mcpServers": {
       "mal": {
         "url": "https://mal-mcp.<account>.workers.dev/u/<hash>/mcp"
       }
     }
   }
   ```

3. Call the `authenticate` MCP tool with the same `client_id` (and `client_secret`). The Worker re-hashes them, verifies the hash matches the URL, stores them in your DO, and returns a MyAnimeList authorization URL. Open it in a browser to complete sign-in — the redirect lands on the callback URL and persists tokens to your session.

Subsequent tool calls just use the stored tokens; the access token is refreshed automatically.

### Security notes for hosted deployments

- The MCP URL contains a hash of your MAL credentials. Treat the URL like a secret — anyone with it can call MAL on your behalf using tokens already stored in your session.
- Knowing only the URL hash is not enough to seed a fresh session: `authenticate` re-verifies the supplied `client_id`/`client_secret` against the URL hash before storing them.
- Different credentials → different hash → fully separate Durable Object. There is no cross-user shared state.
- The Worker holds no MAL credentials of its own; each user supplies their own MAL API client.

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
