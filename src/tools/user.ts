import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MalClient } from "../mal-client.js";
import { run } from "./helpers.js";

const UserAnimeStatus = z.enum([
  "watching",
  "completed",
  "on_hold",
  "dropped",
  "plan_to_watch",
]);

const UserMangaStatus = z.enum([
  "reading",
  "completed",
  "on_hold",
  "dropped",
  "plan_to_read",
]);

const ScoreSchema = z
  .number()
  .int()
  .min(0)
  .max(10)
  .describe("0-10 MAL score (0 = no score)");

export function registerUserTools(server: McpServer, client: MalClient): void {
  server.registerTool(
    "get_current_user",
    {
      title: "Get Current User",
      description:
        "Get information about the authenticated MyAnimeList user (profile + anime statistics). Requires MAL user auth.",
      inputSchema: {
        fields: z
          .string()
          .optional()
          .describe("Comma-separated MAL user fields (default 'anime_statistics')."),
      },
    },
    async ({ fields }) => run(() => client.getCurrentUser(fields)),
  );

  server.registerTool(
    "get_user_anime_list",
    {
      title: "Get User Anime List",
      description:
        "Get the anime list for a MyAnimeList user. Defaults to the authenticated user (@me). Accessing another user's list requires them to have a public list.",
      inputSchema: {
        username: z
          .string()
          .optional()
          .describe("MAL username (defaults to the authenticated user)."),
        status: UserAnimeStatus.optional().describe("Filter by list status."),
        sort: z
          .enum([
            "list_score",
            "list_updated_at",
            "anime_title",
            "anime_start_date",
          ])
          .optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
        fields: z.string().optional(),
        nsfw: z.boolean().optional(),
      },
    },
    async ({ username, status, sort, limit, offset, fields, nsfw }) =>
      run(() =>
        client.getUserAnimeList({
          username,
          status,
          sort,
          limit: limit ?? 100,
          offset,
          fields,
          nsfw,
        }),
      ),
  );

  server.registerTool(
    "update_anime_list_status",
    {
      title: "Update Anime List Status",
      description:
        "Add an anime to the authenticated user's list, or update its status/score/progress. Creates the entry if it does not exist.",
      inputSchema: {
        anime_id: z.number().int().positive(),
        status: UserAnimeStatus.optional(),
        score: ScoreSchema.optional(),
        num_watched_episodes: z.number().int().min(0).optional(),
        is_rewatching: z.boolean().optional(),
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("YYYY-MM-DD"),
        finish_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("YYYY-MM-DD"),
        priority: z.number().int().min(0).max(2).optional(),
        num_times_rewatched: z.number().int().min(0).optional(),
        rewatch_value: z.number().int().min(0).max(5).optional(),
        tags: z
          .string()
          .optional()
          .describe("Comma-separated tag list (MAL stores tags as a single string)."),
        comments: z.string().optional(),
      },
    },
    async ({ anime_id, ...patch }) =>
      run(() => client.updateAnimeListStatus(anime_id, patch)),
  );

  server.registerTool(
    "delete_anime_list_item",
    {
      title: "Delete Anime List Item",
      description: "Remove an anime from the authenticated user's list.",
      inputSchema: {
        anime_id: z.number().int().positive(),
      },
    },
    async ({ anime_id }) =>
      run(async () => {
        await client.deleteAnimeListItem(anime_id);
        return { deleted: true, anime_id };
      }),
  );

  server.registerTool(
    "get_user_manga_list",
    {
      title: "Get User Manga List",
      description:
        "Get the manga list for a MyAnimeList user. Defaults to the authenticated user (@me).",
      inputSchema: {
        username: z.string().optional(),
        status: UserMangaStatus.optional(),
        sort: z
          .enum([
            "list_score",
            "list_updated_at",
            "manga_title",
            "manga_start_date",
          ])
          .optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
        fields: z.string().optional(),
        nsfw: z.boolean().optional(),
      },
    },
    async ({ username, status, sort, limit, offset, fields, nsfw }) =>
      run(() =>
        client.getUserMangaList({
          username,
          status,
          sort,
          limit: limit ?? 100,
          offset,
          fields,
          nsfw,
        }),
      ),
  );

  server.registerTool(
    "update_manga_list_status",
    {
      title: "Update Manga List Status",
      description:
        "Add a manga to the authenticated user's list, or update its status/score/progress.",
      inputSchema: {
        manga_id: z.number().int().positive(),
        status: UserMangaStatus.optional(),
        score: ScoreSchema.optional(),
        num_volumes_read: z.number().int().min(0).optional(),
        num_chapters_read: z.number().int().min(0).optional(),
        is_rereading: z.boolean().optional(),
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        finish_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        priority: z.number().int().min(0).max(2).optional(),
        num_times_reread: z.number().int().min(0).optional(),
        reread_value: z.number().int().min(0).max(5).optional(),
        tags: z.string().optional(),
        comments: z.string().optional(),
      },
    },
    async ({ manga_id, ...patch }) =>
      run(() => client.updateMangaListStatus(manga_id, patch)),
  );

  server.registerTool(
    "delete_manga_list_item",
    {
      title: "Delete Manga List Item",
      description: "Remove a manga from the authenticated user's list.",
      inputSchema: {
        manga_id: z.number().int().positive(),
      },
    },
    async ({ manga_id }) =>
      run(async () => {
        await client.deleteMangaListItem(manga_id);
        return { deleted: true, manga_id };
      }),
  );
}
