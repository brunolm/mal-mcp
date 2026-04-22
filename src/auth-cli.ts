#!/usr/bin/env bun
import { runAuthFlow } from "./auth.js";
import { FileStore } from "./storage.js";

const store = new FileStore();
const existing = await store.getConfig();
const clientId = process.env.MAL_CLIENT_ID ?? existing?.clientId;
const clientSecret = process.env.MAL_CLIENT_SECRET ?? existing?.clientSecret;
const port = Number(process.env.MAL_AUTH_PORT ?? 8765);

if (!clientId) {
  console.error(
    "Missing MAL client_id. Set MAL_CLIENT_ID in the environment, or call the `configure` tool from your MCP client first.",
  );
  process.exit(1);
}

console.log("\nmal-mcp OAuth2 setup");
console.log("--------------------");
console.log(`Callback listening on http://localhost:${port}/callback`);

try {
  const tokens = await runAuthFlow({
    clientId,
    clientSecret,
    port,
    onAuthUrl: (url) => {
      console.log(
        `\nMake sure http://localhost:${port}/callback is registered as an App Redirect URL on your MAL API client, then open:\n`,
      );
      console.log(`${url}\n`);
    },
  });

  await store.setTokens(tokens);

  console.log(`\nSuccess. Tokens saved to ${store.tokenPath}`);
  console.log(
    `Access token expires at ${new Date(tokens.expires_at).toISOString()}; refresh token is used to refresh automatically.`,
  );
  process.exit(0);
} catch (err) {
  console.error("\nAuthorization failed:", (err as Error).message);
  process.exit(1);
}
