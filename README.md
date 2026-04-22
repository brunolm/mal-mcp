# mal-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the [MyAnimeList v2 API](https://myanimelist.net/apiconfig/references/api/v2) to Claude and other MCP-compatible clients. Written in TypeScript, runs locally via [Bun](https://bun.com) over stdio or deploys to [Cloudflare Workers](https://developers.cloudflare.com/workers/) as a hosted multi-user server.

## Tools

### Setup

- `configure` — **stdio only** — store the user's MyAnimeList `client_id` (and `client_secret` if issued). Must be called before any other tool. Not registered on the Worker; on the Worker, each user signs in through the MCP OAuth flow when they add the server to their client.
- `authenticate` — **stdio only (meaningful)** — start the MAL OAuth flow; opens a browser and waits for the local callback. On the Worker this is a no-op kept for compatibility — auth happens automatically on connect via MCP OAuth.
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

## Option 2: Host on Cloudflare Workers (multi-user, MCP OAuth)

A single Worker serves every user behind standard MCP OAuth 2.1 (Dynamic Client Registration). One URL for everyone: `https://mal-mcp.<account>.workers.dev/mcp`. During sign-in each user supplies their own MAL `client_id` (and `client_secret` if issued); per-user state lives in a Durable Object keyed by a hash of those credentials.

### 1. Operator setup (once)

```powershell
bun install
bunx wrangler login
bunx wrangler kv namespace create OAUTH_KV
```

Paste the returned namespace `id` into `wrangler.jsonc` (replace `REPLACE_WITH_KV_ID`), then deploy:

```powershell
bun run worker:deploy
```

For local development:

```powershell
bunx wrangler kv namespace create OAUTH_KV --preview
bun run worker:dev
```

### 2. Each user connects

1. Create a MAL API client at <https://myanimelist.net/apiconfig> (App Type: _other_). Set **App Redirect URL** to:

   ```
   https://mal-mcp.<account>.workers.dev/mal/callback
   ```

   (This exact URL — same for every user of a given deployment.)

2. Add the MCP server to your client:

   ```powershell
   claude mcp add --transport http mal https://mal-mcp.<account>.workers.dev/mcp
   ```

   Or equivalently in config:

   ```json
   {
     "mcpServers": {
       "mal": {
         "url": "https://mal-mcp.<account>.workers.dev/mcp"
       }
     }
   }
   ```

3. Your MCP client will pop a browser tab on first connect. The Worker's authorize page asks for your MAL `client_id` (and `client_secret` if issued), redirects you to MyAnimeList to approve, then returns you to your MCP client — now signed in. Access and refresh tokens are persisted in your Durable Object; the MAL access token is refreshed automatically.

### Security notes for hosted deployments

- The Worker is its own OAuth 2.1 authorization server for MCP. Bearer tokens issued to your MCP client are scoped to you; leaking one lets the bearer call MAL on your behalf until the token expires.
- Different MAL credentials → different Durable Object → fully separate state. There is no cross-user shared state.
- The Worker holds no MAL credentials of its own; each user supplies their own MAL API client.

## Data storage

### stdio

Two plaintext JSON files in your home directory, created with mode `0600` (owner read/write only):

| File                       | Contents                                                                  |
| -------------------------- | ------------------------------------------------------------------------- |
| `~/.mal-mcp-config.json`   | Your MAL `client_id` and (if issued) `client_secret`.                     |
| `~/.mal-mcp-tokens.json`   | MAL `access_token`, `refresh_token`, and `expires_at` after `authenticate`.|

Delete either file to reset the corresponding state. Nothing is sent anywhere besides `myanimelist.net` and `api.myanimelist.net`.

### Hosted Worker

Two Cloudflare storage surfaces:

**`OAUTH_KV` (Workers KV namespace)** — used by `@cloudflare/workers-oauth-provider` and by the MAL authorize relay:

- Registered OAuth clients (Dynamic Client Registration), authorization grants, and access/refresh tokens. The provider stores grant `props` encrypted; the encryption key is wrapped into the issued token itself, so KV snapshots alone are not enough to recover props.
- Short-lived (10-minute TTL) pending-MAL-auth records keyed by a random state string. Each record holds the pending authorize URL, your MAL `client_id`/`client_secret`, the PKCE verifier, and the callback URL. Entries are deleted as soon as the MAL callback consumes them, or expire automatically otherwise. They are stored **as plaintext JSON in KV**.

**`MAL_SESSION` (Durable Object, one per user)** — keyed by `u:<32-hex>` where the hex is the first 32 chars of `sha256("v1:" + mal_client_id + ":" + (mal_client_secret ?? ""))`. Stored as plaintext in the DO's SQLite storage (Cloudflare encrypts DO storage at rest on disk):

- `config`: your MAL `client_id` and (if issued) `client_secret`.
- `tokens`: MAL `access_token`, `refresh_token`, `expires_at`.

Two different MAL credential pairs produce two different hashes → two fully separate Durable Objects with no shared state.

**What is *not* stored:** anime/manga lists, user profile data, search results, or anything else returned from MAL — those flow straight through the request on demand. No analytics, no logs of request contents beyond standard Cloudflare observability metrics.

**What travels over the wire:** MAL `client_id`/`client_secret` are submitted as form fields from your browser to the authorize page over HTTPS. MAL access tokens are forwarded as `Authorization: Bearer …` to `api.myanimelist.net`.

**Resetting a user's state:** revoke the grant from your MCP client (or reconnect), or contact the operator to delete the matching Durable Object. Re-authorizing with the same MAL credentials will reuse the same DO and its existing tokens.

## Environment variables (stdio only)

| Variable            | Required | Purpose                                                             |
| ------------------- | -------- | ------------------------------------------------------------------- |
| `MAL_CLIENT_ID`     | no       | Seeds the stdio config store on first boot if nothing is saved yet. |
| `MAL_CLIENT_SECRET` | no       | Same, for clients that were issued a secret.                        |
| `MAL_AUTH_PORT`     | no       | Port the one-shot OAuth callback listens on (default `8765`).       |

On hosted Worker deployments these env vars are not used; each end user supplies their own MAL credentials through the Worker's authorize page during MCP OAuth sign-in.

## Development

```powershell
bun run dev              # stdio, watch mode
bun run worker:dev       # Worker, local (miniflare)
bun run typecheck        # tsc --noEmit
```

All tools take an optional `fields` string that passes straight through to MAL — see the [field spec](https://myanimelist.net/apiconfig/references/api/v2#section/Common-formats) if you need to override the defaults.
