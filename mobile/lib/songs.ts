import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { ApiError, authFetch, getApiBaseUrl, getFreshAccessToken, loadStoredSession } from "@/lib/auth";
import { readUserCache, writeUserCache } from "@/lib/cache";

const SONG_CATALOG_DIR = `${FileSystem.documentDirectory ?? ""}openband-songs/`;
const DOWNLOADS_DOCUMENT_DIR = `${FileSystem.documentDirectory ?? ""}openband-downloads/`;
const DOWNLOADS_CACHE_DIR = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ""}openband-downloads/`;
const PLAYBACK_CACHE_DIR = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ""}openband-playback/`;
const COVER_CACHE_DIR = `${FileSystem.documentDirectory ?? ""}openband-covers/`;
const SONG_CATALOG_STORAGE_KEY_PREFIX = "openband.songs.catalog";
const COVER_STORAGE_KEY_PREFIX = "openband.song_covers";
const DOWNLOAD_SETTINGS_NAMESPACE = "download-settings";

export type Song = {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration_seconds: number | null;
  source: string;
  original_filename: string;
  file_size: number;
  file_sha256: string;
  mime_type: string;
  tags: string[];
  audio_url: string;
  download_url: string;
  cover_url: string;
  is_liked: boolean;
  liked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SongListResponse = {
  songs: Song[];
  limit: number;
  offset: number;
  total: number;
};

export type SongCacheResult = {
  uri: string;
  cached: boolean;
};

export type SongCacheStatus = "cached" | "downloading" | "remote";

export type DownloadLocation = "app" | "temporary";

export type DownloadSettings = {
  location: DownloadLocation;
};

export type SongCacheBatchItem = {
  song: Song;
  result?: SongCacheResult;
  error?: Error;
};

type SongCatalogSnapshot = {
  updatedAt: string;
  songs: Song[];
};

export type CachedSongList = {
  updatedAt: string;
  isStale: boolean;
  songs: Song[];
  total: number;
  limit: number;
  nextOffset: number;
  hasMore: boolean;
};

type SongListCacheSnapshot = {
  lists: Record<string, CachedSongList>;
};

export type SongLikeResponse = {
  song_id: string;
  is_liked: boolean;
  liked_at: string | null;
};

export async function listSongs(
  accessToken: string,
  limit = 50,
  offset = 0,
  options: { q?: string | null; tag?: string | null } = {},
): Promise<SongListResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (options.tag) {
    params.set("tag", options.tag);
  }
  if (options.q) {
    params.set("q", options.q);
  }
  const response = await authFetch(`/v1/songs?${params.toString()}`, accessToken);
  await assertOk(response);
  return (await response.json()) as SongListResponse;
}

export async function listAllSongs(
  accessToken: string,
  options: { pageSize?: number; concurrency?: number } = {},
): Promise<SongListResponse> {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 200, 200));
  const firstPage = await listSongs(accessToken, pageSize, 0);
  if (firstPage.songs.length >= firstPage.total) {
    return firstPage;
  }

  const offsets: number[] = [];
  for (let offset = firstPage.offset + firstPage.limit; offset < firstPage.total; offset += pageSize) {
    offsets.push(offset);
  }
  const pages = await mapConcurrent(
    offsets,
    Math.max(1, options.concurrency ?? 4),
    (offset) => listSongs(accessToken, pageSize, offset),
  );
  const songs = uniqueSongsById([firstPage, ...pages].flatMap((page) => page.songs));
  return {
    songs,
    limit: songs.length,
    offset: 0,
    total: firstPage.total,
  };
}

export async function listDailySongs(accessToken: string, limit = 20): Promise<SongListResponse> {
  const response = await authFetch(`/v1/songs/daily?limit=${limit}`, accessToken);
  await assertOk(response);
  return (await response.json()) as SongListResponse;
}

export async function listLikedSongs(accessToken: string, limit = 50, offset = 0): Promise<SongListResponse> {
  const response = await authFetch(`/v1/songs/liked?limit=${limit}&offset=${offset}`, accessToken);
  await assertOk(response);
  const body = (await response.json()) as SongListResponse;
  const session = await loadStoredSession();
  await saveSongListCache(session?.user.id, songListCacheKey("liked"), body, { append: offset > 0 });
  return body;
}

export async function getSong(accessToken: string, songId: string): Promise<Song> {
  const response = await authFetch(`/v1/songs/${songId}`, accessToken);
  await assertOk(response);
  return (await response.json()) as Song;
}

export async function setSongLiked(accessToken: string, songId: string, liked: boolean): Promise<SongLikeResponse> {
  const response = await authFetch(`/v1/songs/${songId}/like`, accessToken, {
    method: liked ? "PUT" : "DELETE",
  });
  await assertOk(response);
  const body = (await response.json()) as SongLikeResponse;
  const session = await loadStoredSession();
  await patchCachedSongLike(session?.user.id, body.song_id, body.is_liked, body.liked_at);
  return body;
}

export function songListCacheKey(kind: string, qualifier = "all"): string {
  return `${kind}:${qualifier}`;
}

export async function loadSongListCache(
  userId: number | null | undefined,
  key: string,
): Promise<CachedSongList | null> {
  const snapshot = await readSongListCacheSnapshot(userId);
  return snapshot.lists[key] ?? null;
}

export async function saveSongListCache(
  userId: number | null | undefined,
  key: string,
  response: SongListResponse,
  options: { append?: boolean } = {},
): Promise<CachedSongList> {
  const snapshot = await readSongListCacheSnapshot(userId);
  const existingSongs = options.append ? snapshot.lists[key]?.songs ?? [] : [];
  const songs = uniqueSongsById([...existingSongs, ...response.songs]);
  const nextOffset = Math.max(response.offset + response.songs.length, songs.length);
  const nextList: CachedSongList = {
    updatedAt: new Date().toISOString(),
    isStale: false,
    songs,
    total: response.total,
    limit: response.limit,
    nextOffset,
    hasMore: nextOffset < response.total,
  };
  snapshot.lists[key] = nextList;
  await writeSongListCacheSnapshot(userId, snapshot);
  await mergeSongCatalog(userId, response.songs);
  return nextList;
}

export async function markSongListCachesStale(
  userId: number | null | undefined,
  keys?: string[],
): Promise<void> {
  const snapshot = await readSongListCacheSnapshot(userId);
  const targetKeys = keys ?? Object.keys(snapshot.lists);
  let changed = false;
  for (const key of targetKeys) {
    if (snapshot.lists[key]) {
      snapshot.lists[key] = { ...snapshot.lists[key], isStale: true };
      changed = true;
    }
  }
  if (changed) {
    await writeSongListCacheSnapshot(userId, snapshot);
  }
}

export async function patchCachedSongLike(
  userId: number | null | undefined,
  songId: string,
  isLiked: boolean,
  likedAt: string | null,
): Promise<void> {
  await patchSongCatalog(userId, (song) =>
    song.id === songId ? { ...song, is_liked: isLiked, liked_at: likedAt } : song,
  );

  const snapshot = await readSongListCacheSnapshot(userId);
  let changed = false;
  for (const [key, list] of Object.entries(snapshot.lists)) {
    let songs = list.songs.map((song) =>
      song.id === songId ? { ...song, is_liked: isLiked, liked_at: likedAt } : song,
    );
    if (!isLiked && key === songListCacheKey("liked")) {
      songs = songs.filter((song) => song.id !== songId);
    }
    if (songs !== list.songs || list.songs.some((song) => song.id === songId)) {
      snapshot.lists[key] = {
        ...list,
        isStale: true,
        songs,
        total: key === songListCacheKey("liked") && !isLiked ? Math.max(0, list.total - 1) : list.total,
      };
      changed = true;
    }
  }
  if (changed) {
    await writeSongListCacheSnapshot(userId, snapshot);
  }
}

export async function saveSongCatalog(userId: number | null | undefined, songs: Song[]): Promise<void> {
  const snapshot: SongCatalogSnapshot = {
    updatedAt: new Date().toISOString(),
    songs: uniqueSongsById(songs),
  };
  const value = JSON.stringify(snapshot);

  if (Platform.OS === "web") {
    globalThis.localStorage?.setItem(songCatalogStorageKey(userId), value);
    return;
  }

  if (!canUseNativeCache()) {
    return;
  }
  await ensureCacheDirectory();
  await FileSystem.writeAsStringAsync(songCatalogPath(userId), value);
}

export async function mergeSongCatalog(userId: number | null | undefined, songs: Song[]): Promise<void> {
  if (songs.length === 0) {
    return;
  }
  const currentSongs = await loadSongCatalog(userId);
  await saveSongCatalog(userId, [...currentSongs, ...songs]);
}

export async function loadSongCatalog(userId: number | null | undefined): Promise<Song[]> {
  let value: string | null = null;

  if (Platform.OS === "web") {
    value = globalThis.localStorage?.getItem(songCatalogStorageKey(userId)) ?? null;
  } else if (canUseNativeCache()) {
    const path = songCatalogPath(userId);
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) {
      value = await FileSystem.readAsStringAsync(path);
    }
  }

  if (!value) {
    return [];
  }

  try {
    const snapshot = JSON.parse(value) as Partial<SongCatalogSnapshot>;
    return Array.isArray(snapshot.songs) ? uniqueSongsById(snapshot.songs) : [];
  } catch {
    if (Platform.OS === "web") {
      globalThis.localStorage?.removeItem(songCatalogStorageKey(userId));
    } else if (canUseNativeCache()) {
      await FileSystem.deleteAsync(songCatalogPath(userId), { idempotent: true });
    }
    return [];
  }
}

async function patchSongCatalog(
  userId: number | null | undefined,
  patcher: (song: Song) => Song,
): Promise<void> {
  const songs = await loadSongCatalog(userId);
  if (songs.length === 0) {
    return;
  }
  await saveSongCatalog(userId, songs.map(patcher));
}

async function readSongListCacheSnapshot(
  userId: number | null | undefined,
): Promise<SongListCacheSnapshot> {
  const snapshot = await readUserCache<SongListCacheSnapshot>("song-lists", userId);
  if (!snapshot?.data || typeof snapshot.data !== "object") {
    return { lists: {} };
  }
  return {
    lists: snapshot.data.lists ?? {},
  };
}

async function writeSongListCacheSnapshot(
  userId: number | null | undefined,
  snapshot: SongListCacheSnapshot,
): Promise<void> {
  await writeUserCache("song-lists", userId, snapshot);
}

export async function loadCachedSongs(userId: number | null | undefined): Promise<Song[]> {
  const songs = await loadSongCatalog(userId);
  const cachedPairs = await Promise.all(
    songs.map(async (song) => ({
      song,
      cached: Boolean(await getCachedSongUri(song)),
    })),
  );
  return cachedPairs.filter((pair) => pair.cached).map((pair) => pair.song);
}

export async function getSongCacheStatuses(songs: Song[]): Promise<Record<string, SongCacheStatus>> {
  const statuses: Record<string, SongCacheStatus> = {};
  await Promise.all(
    songs.map(async (song) => {
      statuses[song.id] = (await getCachedSongUri(song)) ? "cached" : "remote";
    }),
  );
  return statuses;
}

export async function getCachedSongUri(song: Song): Promise<string | null> {
  if (!canUseNativeCache()) {
    return null;
  }
  for (const uri of await downloadUrisForSong(song)) {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      return uri;
    }
  }
  return null;
}

export async function cacheSong(song: Song, accessToken: string): Promise<SongCacheResult> {
  if (!canUseNativeCache()) {
    return { uri: absoluteSongUrl(song.download_url), cached: false };
  }

  const cachedUri = await getCachedSongUri(song);
  if (cachedUri) {
    return { uri: cachedUri, cached: true };
  }

  const settings = await getDownloadSettingsForCurrentUser();
  const uri = downloadUriForSong(song, settings.location);
  await ensureDownloadDirectory(settings.location);
  const freshAccessToken = await getFreshAccessToken(accessToken);
  const result = await FileSystem.downloadAsync(absoluteSongUrl(song.download_url), uri, {
    headers: {
      Authorization: `Bearer ${freshAccessToken}`,
    },
  });
  if (result.status < 200 || result.status >= 300) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    throw new ApiError(`Download failed with status ${result.status}.`, result.status);
  }
  return { uri: result.uri, cached: true };
}

export async function cacheSongForPlayback(song: Song, accessToken: string): Promise<SongCacheResult> {
  if (!canUseNativeCache()) {
    return { uri: absoluteSongUrl(song.download_url), cached: false };
  }
  const cachedUri = await getCachedSongUri(song);
  if (cachedUri) {
    return { uri: cachedUri, cached: true };
  }

  await ensurePlaybackCacheDirectory();
  const uri = playbackCacheUriForSong(song);
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) {
    const freshAccessToken = await getFreshAccessToken(accessToken);
    const result = await FileSystem.downloadAsync(absoluteSongUrl(song.download_url), uri, {
      headers: {
        Authorization: `Bearer ${freshAccessToken}`,
      },
    });
    if (result.status < 200 || result.status >= 300) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
      throw new ApiError(`Playback failed with status ${result.status}.`, result.status);
    }
  }
  await prunePlaybackCache(uri);
  return { uri, cached: false };
}

export async function deleteCachedSong(song: Song): Promise<boolean> {
  if (!canUseNativeCache()) {
    return false;
  }
  let deleted = false;
  for (const uri of await downloadUrisForSong(song)) {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
      continue;
    }
    await FileSystem.deleteAsync(uri, { idempotent: true });
    deleted = true;
  }
  return deleted;
}

export async function getDownloadSettings(
  userId: number | null | undefined,
): Promise<DownloadSettings> {
  const snapshot = await readUserCache<DownloadSettings>(DOWNLOAD_SETTINGS_NAMESPACE, userId);
  const location = snapshot?.data?.location;
  return {
    location: location === "temporary" ? "temporary" : "app",
  };
}

export async function setDownloadLocation(
  userId: number | null | undefined,
  location: DownloadLocation,
): Promise<DownloadSettings> {
  const settings: DownloadSettings = { location };
  await writeUserCache(DOWNLOAD_SETTINGS_NAMESPACE, userId, settings);
  return settings;
}

export function downloadLocationLabel(location: DownloadLocation): string {
  return location === "temporary" ? "Temporary Cache" : "App Downloads";
}

export function downloadLocationDescription(location: DownloadLocation): string {
  return location === "temporary"
    ? "Stores new downloads in the app cache. The system may clear them."
    : "Stores new downloads in the app's persistent documents area until you delete them.";
}

export async function cacheSongs(
  songs: Song[],
  accessToken: string,
  options: {
    concurrency?: number;
    onProgress?: (item: SongCacheBatchItem, completed: number, total: number) => void;
  } = {},
): Promise<SongCacheBatchItem[]> {
  const uniqueSongs = uniqueSongsById(songs);
  const total = uniqueSongs.length;
  const results: SongCacheBatchItem[] = new Array(total);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, total || 1));
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < total) {
      const index = nextIndex;
      nextIndex += 1;
      const song = uniqueSongs[index];
      try {
        const result = await cacheSong(song, accessToken);
        results[index] = { song, result };
      } catch (exc) {
        results[index] = {
          song,
          error: exc instanceof Error ? exc : new Error("Song download failed."),
        };
      }
      completed += 1;
      options.onProgress?.(results[index], completed, total);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

export async function getCachedSongCoverUri(song: Song): Promise<string | null> {
  if (!song.cover_url) {
    return null;
  }
  if (Platform.OS === "web") {
    return globalThis.localStorage?.getItem(songCoverStorageKey(song)) ?? null;
  }
  if (!canUseNativeCache()) {
    return null;
  }

  const uri = coverCacheUriForSong(song);
  const info = await FileSystem.getInfoAsync(uri);
  if (info.exists) {
    return uri;
  }

  const legacyUri = legacyCoverCacheUriForSong(song);
  const legacyInfo = await FileSystem.getInfoAsync(legacyUri);
  if (!legacyInfo.exists) {
    return null;
  }

  await ensureCoverCacheDirectory();
  await FileSystem.copyAsync({ from: legacyUri, to: uri });
  return uri;
}

export async function cacheSongCover(song: Song, accessToken: string): Promise<SongCacheResult | null> {
  if (!song.cover_url) {
    return null;
  }
  const cachedUri = await getCachedSongCoverUri(song);
  if (cachedUri) {
    return { uri: cachedUri, cached: true };
  }

  if (Platform.OS === "web") {
    const freshAccessToken = await getFreshAccessToken(accessToken);
    const response = await fetch(absoluteSongUrl(song.cover_url), {
      headers: {
        Authorization: `Bearer ${freshAccessToken}`,
      },
    });
    if (!response.ok) {
      throw new ApiError(`Cover failed with status ${response.status}.`, response.status);
    }
    const dataUri = await blobToDataUri(await response.blob());
    try {
      globalThis.localStorage?.setItem(songCoverStorageKey(song), dataUri);
    } catch {
      // The cover can still be displayed for this render even if persistent web storage is full.
    }
    return { uri: dataUri, cached: true };
  }

  if (!canUseNativeCache()) {
    return { uri: absoluteSongUrl(song.cover_url), cached: false };
  }

  await ensureCoverCacheDirectory();
  const uri = coverCacheUriForSong(song);
  const freshAccessToken = await getFreshAccessToken(accessToken);
  const result = await FileSystem.downloadAsync(absoluteSongUrl(song.cover_url), uri, {
    headers: {
      Authorization: `Bearer ${freshAccessToken}`,
    },
  });
  if (result.status < 200 || result.status >= 300) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    throw new ApiError(`Cover download failed with status ${result.status}.`, result.status);
  }
  return { uri: result.uri, cached: true };
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) {
    return "--:--";
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.max(0, seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function songSubtitle(song: Song): string {
  return song.album ? `${song.artist} · ${song.album}` : song.artist;
}

export function songTagSummary(song: Song, limit = 3): string {
  const tags = song.tags.filter(Boolean);
  const visibleTags = tags.slice(0, limit);
  if (visibleTags.length === 0) {
    return "";
  }
  return `${visibleTags.join(", ")}${tags.length > limit ? ", ..." : ""}`;
}

export function readableFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function getDownloadSettingsForCurrentUser(): Promise<DownloadSettings> {
  const session = await loadStoredSession();
  return getDownloadSettings(session?.user.id);
}

async function downloadUrisForSong(song: Song): Promise<string[]> {
  const settings = await getDownloadSettingsForCurrentUser();
  const preferred = downloadUriForSong(song, settings.location);
  const fallback = downloadUriForSong(song, settings.location === "app" ? "temporary" : "app");
  return preferred === fallback ? [preferred] : [preferred, fallback];
}

function downloadUriForSong(song: Song, location: DownloadLocation): string {
  return `${downloadDirectory(location)}${song.id}-${song.file_sha256.slice(0, 16)}.mp3`;
}

function playbackCacheUriForSong(song: Song): string {
  return `${PLAYBACK_CACHE_DIR}${song.id}-${song.file_sha256.slice(0, 16)}.mp3`;
}

function downloadDirectory(location: DownloadLocation): string {
  return location === "temporary" ? DOWNLOADS_CACHE_DIR : DOWNLOADS_DOCUMENT_DIR;
}

function coverCacheUriForSong(song: Song): string {
  return `${COVER_CACHE_DIR}${song.id}.jpg`;
}

function legacyCoverCacheUriForSong(song: Song): string {
  return `${COVER_CACHE_DIR}${song.id}-${song.file_sha256.slice(0, 16)}.jpg`;
}

function songCoverStorageKey(song: Song): string {
  return `${COVER_STORAGE_KEY_PREFIX}.${song.id}`;
}

function songCatalogPath(userId: number | null | undefined): string {
  return `${SONG_CATALOG_DIR}catalog-${songCatalogId(userId)}.json`;
}

function songCatalogStorageKey(userId: number | null | undefined): string {
  return `${SONG_CATALOG_STORAGE_KEY_PREFIX}.${songCatalogId(userId)}`;
}

function songCatalogId(userId: number | null | undefined): string {
  return userId === null || userId === undefined ? "default" : String(userId);
}

function uniqueSongsById(songs: Song[]): Song[] {
  const byId = new Map<string, Song>();
  for (const song of songs) {
    if (song?.id) {
      byId.set(song.id, song);
    }
  }
  return Array.from(byId.values());
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Cover could not be cached."));
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Cover could not be cached."));
      }
    };
    reader.readAsDataURL(blob);
  });
}

async function ensureCacheDirectory(): Promise<void> {
  const info = await FileSystem.getInfoAsync(SONG_CATALOG_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(SONG_CATALOG_DIR, { intermediates: true });
  }
}

async function ensureDownloadDirectory(location: DownloadLocation): Promise<void> {
  const dir = downloadDirectory(location);
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

async function ensurePlaybackCacheDirectory(): Promise<void> {
  const info = await FileSystem.getInfoAsync(PLAYBACK_CACHE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(PLAYBACK_CACHE_DIR, { intermediates: true });
  }
}

async function ensureCoverCacheDirectory(): Promise<void> {
  const info = await FileSystem.getInfoAsync(COVER_CACHE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(COVER_CACHE_DIR, { intermediates: true });
  }
}

function canUseNativeCache(): boolean {
  return Platform.OS !== "web" && Boolean(FileSystem.documentDirectory);
}

async function prunePlaybackCache(keepUri: string): Promise<void> {
  try {
    const files = await FileSystem.readDirectoryAsync(PLAYBACK_CACHE_DIR);
    await Promise.all(
      files.map(async (file) => {
        const uri = `${PLAYBACK_CACHE_DIR}${file}`;
        if (uri !== keepUri) {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        }
      }),
    );
  } catch {
    // Playback cache cleanup is best-effort.
  }
}

export function absoluteSongUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${getApiBaseUrl()}${path}`;
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  let message = `Request failed with status ${response.status}.`;
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { detail?: string };
    if (body.detail) {
      message = body.detail;
    }
  } catch {
    if (text) {
      message = text;
    }
  }
  throw new ApiError(message, response.status);
}
