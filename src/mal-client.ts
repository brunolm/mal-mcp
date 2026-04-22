import { refreshAccessToken } from "./auth.js";
import type { MalConfig, MalStore, OAuthTokens } from "./storage.js";

const API_BASE = "https://api.myanimelist.net/v2";

export class MalApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = "MalApiError";
  }
}

export class MalNotConfiguredError extends Error {
  constructor() {
    super(
      "MAL client is not configured. Call the `configure` tool with your MyAnimeList `client_id` (and `client_secret` if your app was issued one). Create a client at https://myanimelist.net/apiconfig",
    );
    this.name = "MalNotConfiguredError";
  }
}

export class MalNotAuthenticatedError extends Error {
  constructor() {
    super(
      "This tool requires a MyAnimeList user token. Call the `authenticate` tool to authorize.",
    );
    this.name = "MalNotAuthenticatedError";
  }
}

type RequestAuth = "client-id" | "bearer";

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, string | number | boolean | undefined>;
  auth?: RequestAuth;
}

export class MalClient {
  private cachedConfig: MalConfig | undefined;
  private accessToken: string | undefined;
  private refreshToken: string | undefined;
  private tokenExpiresAt = 0;
  private tokensLoaded = false;

  constructor(private readonly store: MalStore) {}

  getStore(): MalStore {
    return this.store;
  }

  async getConfig(): Promise<MalConfig | undefined> {
    if (this.cachedConfig) return this.cachedConfig;
    const stored = await this.store.getConfig();
    if (stored?.clientId) this.cachedConfig = stored;
    return this.cachedConfig;
  }

  async requireConfig(): Promise<MalConfig> {
    const config = await this.getConfig();
    if (!config?.clientId) throw new MalNotConfiguredError();
    return config;
  }

  async setConfig(config: MalConfig): Promise<void> {
    this.cachedConfig = config;
    await this.store.setConfig(config);
  }

  async hasConfig(): Promise<boolean> {
    return Boolean(await this.getConfig());
  }

  async setTokens(tokens: OAuthTokens): Promise<void> {
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.tokenExpiresAt = tokens.expires_at;
    this.tokensLoaded = true;
    await this.store.setTokens(tokens);
  }

  async hasUserAuth(): Promise<boolean> {
    await this.loadTokens();
    return Boolean(this.accessToken);
  }

  async clearTokens(): Promise<void> {
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.tokenExpiresAt = 0;
    this.tokensLoaded = true;
    await this.store.clearTokens();
  }

  private async loadTokens(): Promise<void> {
    if (this.tokensLoaded) return;
    this.tokensLoaded = true;
    const tokens = await this.store.getTokens();
    if (tokens) {
      this.accessToken = tokens.access_token;
      this.refreshToken = tokens.refresh_token;
      this.tokenExpiresAt = tokens.expires_at;
    }
  }

  private buildQuery(query: RequestOptions["query"]): string {
    if (!query) return "";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", query, body, auth = "client-id" } = options;
    const url = path.startsWith("http") ? path : API_BASE + path;
    const config = await this.requireConfig();

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (auth === "bearer") {
      await this.ensureAccessToken(config);
      if (!this.accessToken) throw new MalNotAuthenticatedError();
      headers.Authorization = `Bearer ${this.accessToken}`;
    } else {
      headers["X-MAL-CLIENT-ID"] = config.clientId;
    }

    let bodyInit: URLSearchParams | undefined;
    if (body) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || v === null) continue;
        params.set(k, String(v));
      }
      bodyInit = params;
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const res = await fetch(url + this.buildQuery(query), {
      method,
      headers,
      body: bodyInit,
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const message =
        (parsed &&
          typeof parsed === "object" &&
          "message" in parsed &&
          typeof (parsed as { message?: unknown }).message === "string" &&
          (parsed as { message: string }).message) ||
        (parsed &&
          typeof parsed === "object" &&
          "error" in parsed &&
          typeof (parsed as { error?: unknown }).error === "string" &&
          (parsed as { error: string }).error) ||
        res.statusText ||
        "MAL API error";
      throw new MalApiError(`MAL API ${res.status}: ${message}`, res.status, parsed);
    }

    return parsed as T;
  }

  private async ensureAccessToken(config: MalConfig): Promise<void> {
    await this.loadTokens();
    const skew = 60_000;
    if (
      this.accessToken &&
      (this.tokenExpiresAt === 0 || Date.now() < this.tokenExpiresAt - skew)
    ) {
      return;
    }
    if (!this.refreshToken) return;

    try {
      const refreshed = await refreshAccessToken({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: this.refreshToken,
      });
      await this.setTokens(refreshed);
    } catch {
      // best-effort refresh; leave stale token and let the next request surface the error
    }
  }

  // ---- Anime ----

  searchAnime(params: {
    q: string;
    limit?: number;
    offset?: number;
    fields?: string;
    nsfw?: boolean;
  }) {
    return this.request<ListResponse<AnimeNode>>("/anime", {
      query: {
        q: params.q,
        limit: params.limit,
        offset: params.offset,
        fields: params.fields ?? DEFAULT_ANIME_FIELDS,
        nsfw: params.nsfw,
      },
    });
  }

  getAnimeDetails(id: number, fields?: string) {
    return this.request<AnimeNode>(`/anime/${id}`, {
      query: { fields: fields ?? DETAILED_ANIME_FIELDS },
    });
  }

  getAnimeRanking(params: {
    ranking_type?: AnimeRankingType;
    limit?: number;
    offset?: number;
    fields?: string;
  }) {
    return this.request<ListResponse<AnimeNode>>("/anime/ranking", {
      query: {
        ranking_type: params.ranking_type ?? "all",
        limit: params.limit,
        offset: params.offset,
        fields: params.fields ?? DEFAULT_ANIME_FIELDS,
      },
    });
  }

  getSeasonalAnime(params: {
    year: number;
    season: Season;
    sort?: "anime_score" | "anime_num_list_users";
    limit?: number;
    offset?: number;
    fields?: string;
    nsfw?: boolean;
  }) {
    return this.request<ListResponse<AnimeNode>>(
      `/anime/season/${params.year}/${params.season}`,
      {
        query: {
          sort: params.sort,
          limit: params.limit,
          offset: params.offset,
          fields: params.fields ?? DEFAULT_ANIME_FIELDS,
          nsfw: params.nsfw,
        },
      },
    );
  }

  getAnimeSuggestions(params: { limit?: number; offset?: number; fields?: string }) {
    return this.request<ListResponse<AnimeNode>>("/anime/suggestions", {
      query: {
        limit: params.limit,
        offset: params.offset,
        fields: params.fields ?? DEFAULT_ANIME_FIELDS,
      },
      auth: "bearer",
    });
  }

  // ---- Manga ----

  searchManga(params: {
    q: string;
    limit?: number;
    offset?: number;
    fields?: string;
    nsfw?: boolean;
  }) {
    return this.request<ListResponse<MangaNode>>("/manga", {
      query: {
        q: params.q,
        limit: params.limit,
        offset: params.offset,
        fields: params.fields ?? DEFAULT_MANGA_FIELDS,
        nsfw: params.nsfw,
      },
    });
  }

  getMangaDetails(id: number, fields?: string) {
    return this.request<MangaNode>(`/manga/${id}`, {
      query: { fields: fields ?? DETAILED_MANGA_FIELDS },
    });
  }

  getMangaRanking(params: {
    ranking_type?: MangaRankingType;
    limit?: number;
    offset?: number;
    fields?: string;
  }) {
    return this.request<ListResponse<MangaNode>>("/manga/ranking", {
      query: {
        ranking_type: params.ranking_type ?? "all",
        limit: params.limit,
        offset: params.offset,
        fields: params.fields ?? DEFAULT_MANGA_FIELDS,
      },
    });
  }

  // ---- User ----

  getCurrentUser(fields?: string) {
    return this.request<MalUser>("/users/@me", {
      query: { fields: fields ?? "anime_statistics" },
      auth: "bearer",
    });
  }

  getUserAnimeList(params: {
    username?: string;
    status?: UserAnimeStatus;
    sort?: "list_score" | "list_updated_at" | "anime_title" | "anime_start_date";
    limit?: number;
    offset?: number;
    fields?: string;
    nsfw?: boolean;
  }) {
    const username = params.username ?? "@me";
    return this.request<ListResponse<AnimeNode & { list_status?: MyAnimeListStatus }>>(
      `/users/${encodeURIComponent(username)}/animelist`,
      {
        query: {
          status: params.status,
          sort: params.sort,
          limit: params.limit,
          offset: params.offset,
          fields: params.fields ?? `list_status,${DEFAULT_ANIME_FIELDS}`,
          nsfw: params.nsfw,
        },
        auth: "bearer",
      },
    );
  }

  updateAnimeListStatus(
    id: number,
    patch: {
      status?: UserAnimeStatus;
      score?: number;
      num_watched_episodes?: number;
      is_rewatching?: boolean;
      start_date?: string;
      finish_date?: string;
      priority?: number;
      num_times_rewatched?: number;
      rewatch_value?: number;
      tags?: string;
      comments?: string;
    },
  ) {
    return this.request<MyAnimeListStatus>(`/anime/${id}/my_list_status`, {
      method: "PATCH",
      body: patch,
      auth: "bearer",
    });
  }

  deleteAnimeListItem(id: number) {
    return this.request<unknown>(`/anime/${id}/my_list_status`, {
      method: "DELETE",
      auth: "bearer",
    });
  }

  getUserMangaList(params: {
    username?: string;
    status?: UserMangaStatus;
    sort?: "list_score" | "list_updated_at" | "manga_title" | "manga_start_date";
    limit?: number;
    offset?: number;
    fields?: string;
    nsfw?: boolean;
  }) {
    const username = params.username ?? "@me";
    return this.request<ListResponse<MangaNode & { list_status?: MyMangaListStatus }>>(
      `/users/${encodeURIComponent(username)}/mangalist`,
      {
        query: {
          status: params.status,
          sort: params.sort,
          limit: params.limit,
          offset: params.offset,
          fields: params.fields ?? `list_status,${DEFAULT_MANGA_FIELDS}`,
          nsfw: params.nsfw,
        },
        auth: "bearer",
      },
    );
  }

  updateMangaListStatus(
    id: number,
    patch: {
      status?: UserMangaStatus;
      score?: number;
      num_volumes_read?: number;
      num_chapters_read?: number;
      is_rereading?: boolean;
      start_date?: string;
      finish_date?: string;
      priority?: number;
      num_times_reread?: number;
      reread_value?: number;
      tags?: string;
      comments?: string;
    },
  ) {
    return this.request<MyMangaListStatus>(`/manga/${id}/my_list_status`, {
      method: "PATCH",
      body: patch,
      auth: "bearer",
    });
  }

  deleteMangaListItem(id: number) {
    return this.request<unknown>(`/manga/${id}/my_list_status`, {
      method: "DELETE",
      auth: "bearer",
    });
  }
}

// ---- Types ----

export interface ListResponse<T> {
  data: Array<{ node: T; ranking?: { rank: number }; [k: string]: unknown }>;
  paging: { previous?: string; next?: string };
  season?: { year: number; season: string };
}

export interface AnimeNode {
  id: number;
  title: string;
  main_picture?: { medium: string; large: string };
  [key: string]: unknown;
}

export interface MangaNode {
  id: number;
  title: string;
  main_picture?: { medium: string; large: string };
  [key: string]: unknown;
}

export interface MalUser {
  id: number;
  name: string;
  [key: string]: unknown;
}

export type Season = "winter" | "spring" | "summer" | "fall";

export type AnimeRankingType =
  | "all"
  | "airing"
  | "upcoming"
  | "tv"
  | "ova"
  | "movie"
  | "special"
  | "bypopularity"
  | "favorite";

export type MangaRankingType =
  | "all"
  | "manga"
  | "novels"
  | "oneshots"
  | "doujin"
  | "manhwa"
  | "manhua"
  | "bypopularity"
  | "favorite";

export type UserAnimeStatus =
  | "watching"
  | "completed"
  | "on_hold"
  | "dropped"
  | "plan_to_watch";

export type UserMangaStatus =
  | "reading"
  | "completed"
  | "on_hold"
  | "dropped"
  | "plan_to_read";

export interface MyAnimeListStatus {
  status?: UserAnimeStatus;
  score?: number;
  num_episodes_watched?: number;
  is_rewatching?: boolean;
  start_date?: string;
  finish_date?: string;
  priority?: number;
  num_times_rewatched?: number;
  rewatch_value?: number;
  tags?: string[];
  comments?: string;
  updated_at?: string;
}

export interface MyMangaListStatus {
  status?: UserMangaStatus;
  score?: number;
  num_volumes_read?: number;
  num_chapters_read?: number;
  is_rereading?: boolean;
  start_date?: string;
  finish_date?: string;
  priority?: number;
  num_times_reread?: number;
  reread_value?: number;
  tags?: string[];
  comments?: string;
  updated_at?: string;
}

export const DEFAULT_ANIME_FIELDS =
  "id,title,main_picture,alternative_titles,start_date,end_date,synopsis,mean,rank,popularity,status,genres,media_type,num_episodes,start_season,rating,studios";

export const DETAILED_ANIME_FIELDS =
  `${DEFAULT_ANIME_FIELDS},num_list_users,num_scoring_users,source,average_episode_duration,broadcast,related_anime,related_manga,recommendations,statistics`;

export const DEFAULT_MANGA_FIELDS =
  "id,title,main_picture,alternative_titles,start_date,end_date,synopsis,mean,rank,popularity,status,genres,media_type,num_volumes,num_chapters,authors{first_name,last_name}";

export const DETAILED_MANGA_FIELDS =
  `${DEFAULT_MANGA_FIELDS},num_list_users,num_scoring_users,serialization{name},related_anime,related_manga,recommendations`;
