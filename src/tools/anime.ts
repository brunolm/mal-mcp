import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MalClient } from "../mal-client.js";
import { run } from "./helpers.js";

const SeasonSchema = z.enum(["winter", "spring", "summer", "fall"]);

const AnimeRankingSchema = z.enum([
  "all",
  "airing",
  "upcoming",
  "tv",
  "ova",
  "movie",
  "special",
  "bypopularity",
  "favorite",
]);

export function registerAnimeTools(server: McpServer, client: MalClient): void {
  server.registerTool(
    "search_anime",
    {
      title: "Search Anime",
      description:
        "Search MyAnimeList for anime matching a title query. Returns ID, title, synopsis, score and other metadata for each match.",
      inputSchema: {
        query: z.string().min(1).describe("Search query (anime title)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results, 1-100 (default 10)"),
        offset: z.number().int().min(0).optional(),
        fields: z
          .string()
          .optional()
          .describe(
            "Override the default field set (comma-separated MAL field spec).",
          ),
        nsfw: z.boolean().optional().describe("Include NSFW results (default false)"),
      },
    },
    async ({ query, limit, offset, fields, nsfw }) =>
      run(() =>
        client.searchAnime({
          q: query,
          limit: limit ?? 10,
          offset,
          fields,
          nsfw,
        }),
      ),
  );

  server.registerTool(
    "get_anime_details",
    {
      title: "Get Anime Details",
      description:
        "Fetch detailed information about a specific anime by its MyAnimeList ID.",
      inputSchema: {
        anime_id: z.number().int().positive().describe("MyAnimeList anime ID"),
        fields: z
          .string()
          .optional()
          .describe("Override the default detailed field set."),
      },
    },
    async ({ anime_id, fields }) =>
      run(() => client.getAnimeDetails(anime_id, fields)),
  );

  server.registerTool(
    "get_anime_ranking",
    {
      title: "Get Anime Ranking",
      description:
        "Get ranked anime by category (overall, airing, upcoming, TV, movie, by popularity, favorites, etc.).",
      inputSchema: {
        ranking_type: AnimeRankingSchema.optional().describe(
          "Ranking category (default 'all').",
        ),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
        fields: z.string().optional(),
      },
    },
    async ({ ranking_type, limit, offset, fields }) =>
      run(() =>
        client.getAnimeRanking({
          ranking_type,
          limit: limit ?? 20,
          offset,
          fields,
        }),
      ),
  );

  server.registerTool(
    "get_seasonal_anime",
    {
      title: "Get Seasonal Anime",
      description: "List anime from a given year/season.",
      inputSchema: {
        year: z
          .number()
          .int()
          .min(1917)
          .max(2100)
          .describe("Four-digit year, e.g. 2026"),
        season: SeasonSchema.describe("winter | spring | summer | fall"),
        sort: z
          .enum(["anime_score", "anime_num_list_users"])
          .optional()
          .describe("Sort order (default MAL default)."),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
        fields: z.string().optional(),
        nsfw: z.boolean().optional(),
      },
    },
    async ({ year, season, sort, limit, offset, fields, nsfw }) =>
      run(() =>
        client.getSeasonalAnime({
          year,
          season,
          sort,
          limit: limit ?? 50,
          offset,
          fields,
          nsfw,
        }),
      ),
  );

  server.registerTool(
    "get_anime_suggestions",
    {
      title: "Get Anime Suggestions",
      description:
        "Get personalized anime suggestions for the authenticated user. Requires MAL user auth.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        fields: z.string().optional(),
      },
    },
    async ({ limit, offset, fields }) =>
      run(() =>
        client.getAnimeSuggestions({
          limit: limit ?? 20,
          offset,
          fields,
        }),
      ),
  );
}
