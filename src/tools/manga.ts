import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MalClient } from "../mal-client.js";
import { run } from "./helpers.js";

const MangaRankingSchema = z.enum([
  "all",
  "manga",
  "novels",
  "oneshots",
  "doujin",
  "manhwa",
  "manhua",
  "bypopularity",
  "favorite",
]);

export function registerMangaTools(server: McpServer, client: MalClient): void {
  server.registerTool(
    "search_manga",
    {
      title: "Search Manga",
      description: "Search MyAnimeList for manga matching a title query.",
      inputSchema: {
        query: z.string().min(1).describe("Search query (manga title)"),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        fields: z.string().optional(),
        nsfw: z.boolean().optional(),
      },
    },
    async ({ query, limit, offset, fields, nsfw }) =>
      run(() =>
        client.searchManga({
          q: query,
          limit: limit ?? 10,
          offset,
          fields,
          nsfw,
        }),
      ),
  );

  server.registerTool(
    "get_manga_details",
    {
      title: "Get Manga Details",
      description: "Fetch detailed information about a specific manga by its MyAnimeList ID.",
      inputSchema: {
        manga_id: z.number().int().positive().describe("MyAnimeList manga ID"),
        fields: z.string().optional(),
      },
    },
    async ({ manga_id, fields }) =>
      run(() => client.getMangaDetails(manga_id, fields)),
  );

  server.registerTool(
    "get_manga_ranking",
    {
      title: "Get Manga Ranking",
      description:
        "Get ranked manga by category (overall, novels, oneshots, doujin, manhwa, manhua, by popularity, favorites, etc.).",
      inputSchema: {
        ranking_type: MangaRankingSchema.optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
        fields: z.string().optional(),
      },
    },
    async ({ ranking_type, limit, offset, fields }) =>
      run(() =>
        client.getMangaRanking({
          ranking_type,
          limit: limit ?? 20,
          offset,
          fields,
        }),
      ),
  );
}
