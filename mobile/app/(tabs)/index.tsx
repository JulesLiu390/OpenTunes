import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { AlbumArt } from "@/components/AlbumArt";
import { Section } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { MusicPage } from "@/components/MusicPage";
import { usePlayer } from "@/components/PlayerProvider";
import { SongActionMenu } from "@/components/SongActionMenu";
import { SongArtwork } from "@/components/SongArtwork";
import { SongListRow } from "@/components/SongListRow";
import {
  DailyPlaylistSummary,
  DailyTodayResponse,
  generateTodayDaily,
  getTodayDaily,
  listDailyHistory,
  loadCachedDailyHistory,
  loadCachedDailyPlaylist,
  loadCachedDailyToday,
} from "@/lib/daily";
import {
  Song,
  SongCacheStatus,
  cacheSong,
  deleteCachedSong,
  formatDuration,
  getSongCacheStatuses,
  listSongs,
  loadSongListCache,
  loadSongCatalog,
  mergeSongCatalog,
  saveSongListCache,
  songListCacheKey,
  songTagSummary,
} from "@/lib/songs";
import { artworkPalettes, theme } from "@/lib/theme";

const CATALOG_PAGE_SIZE = 50;
const DAILY_HISTORY_PAGE_SIZE = 20;
const CATALOG_CACHE_KEY = songListCacheKey("library");

const WORKING_STATUSES = new Set([
  "queued",
  "generating_tags",
  "generating_playlist_prompt",
  "generating_song_prompts",
  "suno_queue",
  "submitting_to_suno",
  "importing",
]);
const RESUMABLE_STATUSES = new Set(["failed", "captcha_required"]);
const MOOD_TAGS = new Set([
  "atmospheric",
  "chill",
  "dark",
  "energetic",
  "epic",
  "melancholic",
  "melodic",
  "mellow",
  "night",
  "rainy",
  "sleep",
  "soft",
]);
const VOICE_TAG_PATTERNS = ["vocal", "vocalist", "choir", "male", "female"];
const INSTRUMENT_TAGS = new Set([
  "bass",
  "drums",
  "guitar",
  "piano",
  "synth",
  "trumpet",
]);

export default function DailyScreen() {
  const { session } = useAuth();
  const { busySongId, currentSong, isPlaying, playSong, updateCurrentSongLike } = usePlayer();
  const [today, setToday] = useState<DailyTodayResponse | null>(null);
  const [history, setHistory] = useState<DailyPlaylistSummary[]>([]);
  const [selectedTrack, setSelectedTrack] = useState({
    title: "Daily",
    subtitle: "OpenTunes",
  });
  const [cacheStatus, setCacheStatus] = useState<Record<string, SongCacheStatus>>({});
  const [loading, setLoading] = useState(false);
  const [loadingHistoryMore, setLoadingHistoryMore] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [catalogSongs, setCatalogSongs] = useState<Song[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [historyPageInfo, setHistoryPageInfo] = useState({
    total: 0,
    nextOffset: 0,
    hasMore: false,
  });

  const playlist = today?.playlist ?? null;
  const songs = useMemo(() => playlist?.songs.map((entry) => entry.song) ?? [], [playlist]);
  const tagSourceSongs = useMemo(() => uniqueSongsById([...catalogSongs, ...songs]), [catalogSongs, songs]);
  const selectedTagKeys = useMemo(() => new Set(selectedTags.map(tagKey)), [selectedTags]);
  const tagFilterSongs = useMemo(
    () => tagSourceSongs.filter((song) => songMatchesSelectedTags(song, selectedTagKeys)),
    [selectedTagKeys, tagSourceSongs],
  );
  const tagCategories = useMemo(() => categorizeSongTags(tagFilterSongs), [tagFilterSongs]);
  const tagCount = useMemo(
    () => tagCategories.reduce((total, category) => total + category.tags.length, 0),
    [tagCategories],
  );
  const timeline = useMemo(() => buildDailyTimeline(history, today), [history, today]);
  const activeJob = today?.active_job ?? null;
  const isWorking = Boolean(activeJob && (activeJob.status === "queued" || activeJob.status === "running")) ||
    WORKING_STATUSES.has(today?.status ?? "");

  const refreshDaily = useCallback(
    async (options: { showSpinner?: boolean; date?: string } = {}) => {
      if (!session) {
        return;
      }
      if (options.showSpinner) {
        setLoading(true);
      }
      setError(null);
      try {
        const [todayResponse, historyResponse] = await Promise.all([
          getTodayDaily(session.accessToken, options.date),
          listDailyHistory(session.accessToken, DAILY_HISTORY_PAGE_SIZE),
        ]);
        setToday(todayResponse);
        setHistory(historyResponse.playlists);
        setHistoryPageInfo({
          total: historyResponse.total,
          nextOffset: historyResponse.offset + historyResponse.playlists.length,
          hasMore: historyResponse.offset + historyResponse.playlists.length < historyResponse.total,
        });
        const nextSongs = todayResponse.playlist?.songs.map((entry) => entry.song) ?? [];
        await mergeSongCatalog(session.user.id, nextSongs);
        setCatalogSongs((current) => uniqueSongsById([...current, ...nextSongs]));
        await updateCacheStatuses(nextSongs);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Daily could not load.");
      } finally {
        if (options.showSpinner) {
          setLoading(false);
        }
      }
    },
    [session],
  );

  useEffect(() => {
    let mounted = true;

    async function restoreAndRefreshDaily() {
      if (!session) {
        setToday(null);
        setHistory([]);
        setHistoryPageInfo({ total: 0, nextOffset: 0, hasMore: false });
        return;
      }

      const [cachedToday, cachedHistory] = await Promise.all([
        loadCachedDailyToday(session.user.id),
        loadCachedDailyHistory(session.user.id),
      ]);
      if (!mounted) {
        return;
      }
      if (cachedToday) {
        setToday(cachedToday);
        const cachedSongs = cachedToday.playlist?.songs.map((entry) => entry.song) ?? [];
        if (cachedSongs.length) {
          setCacheStatus(await getSongCacheStatuses(cachedSongs));
        }
      }
      if (cachedHistory) {
        setHistory(cachedHistory.playlists);
        setHistoryPageInfo({
          total: cachedHistory.total,
          nextOffset: cachedHistory.nextOffset,
          hasMore: cachedHistory.hasMore,
        });
      }
      await refreshDaily({ showSpinner: !cachedToday && !cachedHistory });
    }

    restoreAndRefreshDaily();

    return () => {
      mounted = false;
    };
  }, [refreshDaily, session]);

  useEffect(() => {
    if (!session) {
      setCatalogSongs([]);
      return;
    }
    const activeSession = session;
    let mounted = true;

    async function loadExistingSongs() {
      const [cachedList, cachedCatalogSongs] = await Promise.all([
        loadSongListCache(activeSession.user.id, CATALOG_CACHE_KEY),
        loadSongCatalog(activeSession.user.id),
      ]);
      const cachedSongs = cachedList?.songs.length ? cachedList.songs : cachedCatalogSongs;
      if (mounted && cachedSongs.length) {
        setCatalogSongs((current) => uniqueSongsById([...current, ...cachedSongs]));
      }
      try {
        const response = await listSongs(activeSession.accessToken, CATALOG_PAGE_SIZE, 0);
        const cached = await saveSongListCache(activeSession.user.id, CATALOG_CACHE_KEY, response);
        if (mounted) {
          setCatalogSongs((current) => uniqueSongsById([...current, ...cached.songs]));
        }
      } catch {
        // The cached catalog is enough for the tag view when the network is unavailable.
      }
    }

    loadExistingSongs();

    return () => {
      mounted = false;
    };
  }, [session]);

  useEffect(() => {
    if (!session || !isWorking) {
      return;
    }
    const timer = setInterval(() => {
      refreshDaily({ date: today?.date });
    }, 5000);
    return () => clearInterval(timer);
  }, [isWorking, refreshDaily, session, today?.date]);

  async function updateCacheStatuses(nextSongs: Song[]) {
    setCacheStatus(await getSongCacheStatuses(nextSongs));
  }

  async function startDailyGeneration() {
    if (!session || generating || isWorking) {
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const resume = RESUMABLE_STATUSES.has(today?.status ?? "");
      const response = await generateTodayDaily(session.accessToken, {
        date: today?.date,
        resume,
        jobId: resume ? (today?.active_job?.id ?? today?.playlist?.job_id) : null,
      });
      setToday({
        date: response.date,
        status: response.status,
        playlist: response.playlist,
        active_job: response.job,
      });
      const nextSongs = response.playlist?.songs.map((entry) => entry.song) ?? [];
      await mergeSongCatalog(session.user.id, nextSongs);
      setCatalogSongs((current) => uniqueSongsById([...current, ...nextSongs]));
      await updateCacheStatuses(nextSongs);
      await refreshDaily({ date: response.date });
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Daily generation could not start.");
    } finally {
      setGenerating(false);
    }
  }

  async function selectDailyDate(item: DailyDateItem) {
    if (!session) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [cachedToday, cachedPlaylist] = await Promise.all([
        loadCachedDailyToday(session.user.id, item.date),
        loadCachedDailyPlaylist(session.user.id, item.date),
      ]);
      if (cachedToday) {
        setToday(cachedToday);
      } else if (cachedPlaylist) {
        setToday({
          date: cachedPlaylist.date,
          status: cachedPlaylist.status,
          playlist: cachedPlaylist,
          active_job: null,
        });
      }
      const response = await getTodayDaily(session.accessToken, item.date);
      setToday(response);
      const nextSongs = response.playlist?.songs.map((entry) => entry.song) ?? [];
      await mergeSongCatalog(session.user.id, nextSongs);
      setCatalogSongs((current) => uniqueSongsById([...current, ...nextSongs]));
      await updateCacheStatuses(nextSongs);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Daily date could not load.");
    } finally {
      setLoading(false);
    }
  }

  async function loadMoreHistory() {
    if (!session || loading || loadingHistoryMore || !historyPageInfo.hasMore) {
      return;
    }
    setLoadingHistoryMore(true);
    setError(null);
    try {
      const response = await listDailyHistory(session.accessToken, DAILY_HISTORY_PAGE_SIZE, historyPageInfo.nextOffset);
      const nextHistory = mergeDailyHistory(history, response.playlists);
      setHistory(nextHistory);
      const nextOffset = Math.max(response.offset + response.playlists.length, nextHistory.length);
      setHistoryPageInfo({
        total: response.total,
        nextOffset,
        hasMore: nextOffset < response.total,
      });
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "History could not load.");
    } finally {
      setLoadingHistoryMore(false);
    }
  }

  async function selectSong(song: Song) {
    setSelectedTrack({ title: song.title, subtitle: songTagSummary(song) });
    if (!session || cacheStatus[song.id] === "downloading") {
      return;
    }

    try {
      const result = await playSong(song, songs, { source: "daily" });
      if (result) {
        setCacheStatus((current) => ({ ...current, [song.id]: result.cached ? "cached" : "remote" }));
      } else if (cacheStatus[song.id] !== "cached") {
        setCacheStatus((current) => ({ ...current, [song.id]: "remote" }));
      }
    } catch {
      setCacheStatus((current) => ({ ...current, [song.id]: "remote" }));
    }
  }

  async function playDailyAll() {
    const firstSong = songs[0];
    if (!firstSong) {
      return;
    }
    await selectSong(firstSong);
  }

  function toggleTag(tag: string) {
    const key = tagKey(tag);
    setSelectedTags((current) =>
      current.some((item) => tagKey(item) === key)
        ? current.filter((item) => tagKey(item) !== key)
        : [...current, tag],
    );
  }

  async function downloadSong(song: Song) {
    if (!session || cacheStatus[song.id] === "downloading") {
      return;
    }
    setCacheStatus((current) => ({ ...current, [song.id]: "downloading" }));
    try {
      const result = await cacheSong(song, session.accessToken);
      await mergeSongCatalog(session.user.id, [song]);
      setCatalogSongs((current) => uniqueSongsById([...current, song]));
      setCacheStatus((current) => ({ ...current, [song.id]: result.cached ? "cached" : "remote" }));
    } catch (exc) {
      setCacheStatus((current) => ({ ...current, [song.id]: "remote" }));
      throw exc;
    }
  }

  async function removeDownload(song: Song) {
    await deleteCachedSong(song);
    setCacheStatus((current) => ({ ...current, [song.id]: "remote" }));
  }

  function updateSongLike(songId: string, isLiked: boolean, likedAt: string | null) {
    setToday((current) => {
      if (!current?.playlist) {
        return current;
      }
      return {
        ...current,
        playlist: {
          ...current.playlist,
          songs: current.playlist.songs.map((entry) =>
            entry.song.id === songId ? { ...entry, song: { ...entry.song, is_liked: isLiked, liked_at: likedAt } } : entry,
          ),
        },
      };
    });
    updateCurrentSongLike(songId, isLiked, likedAt);
  }

  const heroSong = songs[0];
  const heroTitle = playlist?.title ?? "Daily";
  const heroMeta = dailyHeroMeta(today, songs.length);
  const generateDisabled = generating || isWorking || loading;

  return (
    <MusicPage
      onEndReached={historyPageInfo.hasMore ? loadMoreHistory : undefined}
      playerTitle={selectedTrack.title}
      playerSubtitle={selectedTrack.subtitle}>
      <Section>
        <Text style={styles.eyebrow}>{today?.date ?? "Today"}</Text>
        <Text style={styles.title}>Daily</Text>
      </Section>

      <Section>
        <View style={styles.hero}>
          {heroSong ? (
            <SongArtwork accessToken={session?.accessToken ?? null} colors={artworkPalettes[1]} size={112} song={heroSong} />
          ) : (
            <AlbumArt colors={artworkPalettes[1]} size={112} />
          )}
          <View style={styles.heroCopy}>
            <Text style={styles.heroLabel}>{statusLabel(today?.status ?? "not_started")}</Text>
            <Text style={styles.heroTitle} numberOfLines={2}>
              {heroTitle}
            </Text>
            <Text style={styles.heroMeta} numberOfLines={2}>
              {heroMeta}
            </Text>
            {songs.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                disabled={Boolean(busySongId)}
                onPress={playDailyAll}
                style={({ pressed }) => [
                  styles.generateButton,
                  pressed && styles.pressed,
                  Boolean(busySongId) && styles.disabled,
                ]}>
                <Text style={styles.generateButtonText}>Play All</Text>
              </Pressable>
            ) : playlist?.status === "ready" ? null : (
              <Pressable
                accessibilityRole="button"
                disabled={generateDisabled}
                onPress={startDailyGeneration}
                style={({ pressed }) => [
                  styles.generateButton,
                  pressed && styles.pressed,
                  generateDisabled && styles.disabled,
                ]}>
                <Text style={styles.generateButtonText}>{generateButtonText(today?.status, generating, isWorking)}</Text>
              </Pressable>
            )}
          </View>
        </View>
      </Section>

      <Section>
        <View style={styles.cardGrid}>
          <View style={styles.dailyCard}>
            <Text style={styles.cardLabel}>Status</Text>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {statusLabel(today?.status ?? "not_started")}
            </Text>
            <Text style={styles.cardSubtitle} numberOfLines={2}>
              {activeJob ? statusLabel(activeJob.stage) : playlist?.error || "Personal generation queue"}
            </Text>
            <Text style={styles.cardMeta}>{playlist ? `${playlist.song_count} songs` : "No songs yet"}</Text>
          </View>

          <View style={styles.dailyCard}>
            <Text style={styles.cardLabel}>History</Text>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {timeline.length ? `${timeline.length} days` : "Empty"}
            </Text>
            <Text style={styles.cardSubtitle} numberOfLines={2}>
              Separate from Play Lists
            </Text>
            <Text style={styles.cardMeta}>{timeline[0]?.date ?? "Start today"}</Text>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={() => setTagsOpen((open) => !open)}
            style={({ pressed }) => [styles.dailyCard, tagsOpen && styles.dailyCardActive, pressed && styles.pressed]}>
            <Text style={styles.cardLabel}>Tags</Text>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {tagCount ? `${tagCount} tags` : "Empty"}
            </Text>
            <Text style={styles.cardSubtitle} numberOfLines={2}>
              {selectedTags.length
                ? `${tagFilterSongs.length} matching songs`
                : tagCategories.length
                  ? `${tagCategories.length} categories`
                  : "No tags yet"}
            </Text>
            <Text style={styles.cardMeta}>{tagsOpen ? (selectedTags.length ? `${selectedTags.length} selected` : "Hide") : "Open"}</Text>
          </Pressable>
        </View>
      </Section>

      {tagsOpen ? (
        <Section>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Tags</Text>
            {selectedTags.length ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setSelectedTags([])}
                style={({ pressed }) => [styles.clearTagButton, pressed && styles.pressed]}>
                <Text style={styles.clearTagText}>All Tags</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.tagCategoryList}>
            {tagCategories.length ? (
              tagCategories.map((category) => (
                <View key={category.label} style={styles.tagCategory}>
                  <View style={styles.tagCategoryHeader}>
                    <Text style={styles.tagCategoryTitle}>{category.label}</Text>
                    <Text style={styles.tagCategoryCount}>{category.tags.length}</Text>
                  </View>
                  <View style={styles.tagWrap}>
                    {category.tags.map((item) => {
                      const active = selectedTagKeys.has(tagKey(item.tag));
                      return (
                        <Pressable
                          accessibilityRole="button"
                          key={item.tag}
                          onPress={() => toggleTag(item.tag)}
                          style={({ pressed }) => [styles.tagPill, active && styles.tagPillActive, pressed && styles.pressed]}>
                          <Text style={[styles.tagText, active && styles.tagTextActive]}>{item.tag}</Text>
                          <Text style={styles.tagCount}>{item.count}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))
            ) : (
              <View style={styles.emptyPanel}>
                <Text style={styles.emptyTitle}>No Tags Yet</Text>
                <Text style={styles.emptyMeta}>Daily songs will add tags here.</Text>
              </View>
            )}
          </View>
        </Section>
      ) : null}

      {timeline.length > 0 ? (
        <Section>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>History</Text>
            {loading ? <ActivityIndicator color={theme.colors.tint} size="small" /> : null}
          </View>
          <View style={styles.historyGrid}>
            {timeline.map((item) => (
              <Pressable
                key={item.date}
                onPress={() => selectDailyDate(item)}
                style={({ pressed }) => [
                  styles.historyCard,
                  today?.date === item.date && styles.historyCardActive,
                  pressed && styles.pressed,
                ]}>
                <Text style={styles.historyDate}>{item.date}</Text>
                <Text style={styles.historyMeta}>{dailyDateMeta(item)}</Text>
              </Pressable>
            ))}
          </View>
          {loadingHistoryMore ? <Text style={styles.loadingMoreText}>Loading more history</Text> : null}
        </Section>
      ) : null}

      <Section>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Daily Playlist</Text>
          {loading || isWorking ? <ActivityIndicator color={theme.colors.tint} size="small" /> : null}
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.list}>
          {songs.length > 0 ? (
            songs.map((song, index) => {
              const displaySong = currentSong?.id === song.id ? currentSong : song;
              const tagPreview = songTagSummary(displaySong);
              return (
                <SongListRow
                  accessToken={session?.accessToken ?? null}
                  action={
                    <SongActionMenu
                      accessToken={session?.accessToken ?? null}
                      isDownloaded={cacheStatus[displaySong.id] === "cached"}
                      isLiked={Boolean(displaySong.is_liked)}
                      onDownload={downloadSong}
                      onLikeChanged={updateSongLike}
                      onRemoveDownload={removeDownload}
                      song={displaySong}
                    />
                  }
                  colors={artworkPalettes[index % artworkPalettes.length]}
                  isCached={cacheStatus[song.id] === "cached"}
                  key={song.id}
                  onPress={() => selectSong(song)}
                  isLiked={Boolean(displaySong.is_liked)}
                  song={displaySong}
                  statusActive={currentSong?.id === song.id}
                  statusText={songStatusText(song, cacheStatus[song.id], busySongId, currentSong?.id, isPlaying)}
                  subtitle={tagPreview}
                />
              );
            })
          ) : (
            <View style={styles.emptyPanel}>
              <Text style={styles.emptyTitle}>{isWorking ? "Generating Daily" : "No Daily Yet"}</Text>
              <Text style={styles.emptyMeta}>{isWorking ? statusLabel(activeJob?.stage ?? today?.status ?? "") : "Create today's AI playlist from your taste tags"}</Text>
            </View>
          )}
        </View>
      </Section>
    </MusicPage>
  );
}

function songStatusText(
  song: Song,
  cacheStatus: SongCacheStatus | undefined,
  busySongId: string | null,
  currentSongId: string | undefined,
  isPlaying: boolean,
): string {
  if (busySongId === song.id || cacheStatus === "downloading") {
    return "Loading";
  }
  if (currentSongId === song.id && isPlaying) {
    return "Playing";
  }
  return formatDuration(song.duration_seconds);
}

function dailyHeroMeta(today: DailyTodayResponse | null, songCount: number): string {
  if (!today || today.status === "not_started") {
    return "Generate a private AI playlist for today";
  }
  if (today.status === "ready") {
    return `${songCount} songs ready`;
  }
  if (today.status === "failed") {
    return today.playlist?.error || today.active_job?.error || "Generation failed";
  }
  if (today.status === "captcha_required") {
    return today.playlist?.error || today.active_job?.error || "Suno needs human verification";
  }
  return statusLabel(today.active_job?.stage ?? today.status);
}

function generateButtonText(status: string | undefined, generating: boolean, isWorking: boolean): string {
  if (generating || isWorking) {
    return "Generating";
  }
  if (status === "failed") {
    return "Retry";
  }
  if (status === "captcha_required") {
    return "Continue";
  }
  return "Generate";
}

function statusLabel(status: string): string {
  if (status.startsWith("suno_batch_")) {
    return `Suno Batch ${status.replace("suno_batch_", "")}`;
  }
  switch (status) {
    case "not_started":
      return "Not Generated";
    case "queued":
      return "Queued";
    case "generating_tags":
      return "Tag Seeds";
    case "generating_playlist_prompt":
      return "Daily Plan";
    case "generating_song_prompts":
      return "Song Prompts";
    case "suno_queue":
      return "Suno Queue";
    case "submitting_to_suno":
      return "Suno Batch";
    case "importing":
      return "Importing";
    case "ready":
      return "Ready";
    case "captcha_required":
      return "Captcha Required";
    case "failed":
      return "Failed";
    default:
      return status ? status.replace(/_/g, " ") : "Daily";
  }
}

type TagItem = {
  tag: string;
  count: number;
};

type TagCategory = {
  label: string;
  tags: TagItem[];
};

type DailyDateItem = {
  date: string;
  status: string;
  song_count: number;
  playlist: DailyPlaylistSummary | null;
};

function buildDailyTimeline(history: DailyPlaylistSummary[], selected: DailyTodayResponse | null): DailyDateItem[] {
  const byDate = new Map(history.map((item) => [item.date, item]));
  const dates = new Set<string>(history.map((item) => item.date));
  const today = todayIsoDate();

  if (history.length === 0) {
    dates.add(selected?.date ?? today);
    dates.add(today);
  } else {
    const latestGeneratedDate = history.reduce((latest, item) => (item.date > latest ? item.date : latest), history[0].date);
    const endDate = maxIsoDate(today, selected?.date ?? today);
    const cursor = parseIsoDate(endDate);
    while (formatIsoDate(cursor) >= latestGeneratedDate) {
      dates.add(formatIsoDate(cursor));
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  return Array.from(dates)
    .sort((left, right) => right.localeCompare(left))
    .map((dateValue) => {
      const selectedForDate = selected?.date === dateValue ? selected : null;
      const playlist = selectedForDate?.playlist ?? byDate.get(dateValue) ?? null;
      return {
        date: dateValue,
        status: selectedForDate?.status ?? playlist?.status ?? "not_started",
        song_count: selectedForDate?.playlist?.song_count ?? playlist?.song_count ?? 0,
        playlist,
      };
    });
}

function mergeDailyHistory(
  current: DailyPlaylistSummary[],
  incoming: DailyPlaylistSummary[],
): DailyPlaylistSummary[] {
  const byDate = new Map<string, DailyPlaylistSummary>();
  for (const item of [...current, ...incoming]) {
    byDate.set(item.date, item);
  }
  return Array.from(byDate.values()).sort((left, right) => right.date.localeCompare(left.date));
}

function dailyDateMeta(item: DailyDateItem): string {
  if (item.song_count > 0) {
    return `${item.song_count} songs`;
  }
  if (item.status === "not_started") {
    return "Generate";
  }
  return statusLabel(item.status);
}

function todayIsoDate(): string {
  return formatIsoDate(new Date());
}

function maxIsoDate(left: string, right: string): string {
  return left >= right ? left : right;
}

function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(year, month - 1, day);
}

function formatIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function categorizeSongTags(songs: Song[]): TagCategory[] {
  const counts = new Map<string, TagItem>();
  for (const song of songs) {
    const seen = new Set<string>();
    for (const rawTag of song.tags) {
      const tag = rawTag.trim();
      const key = tagKey(tag);
      if (!key || key.startsWith("no ") || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { tag, count: 1 });
      }
    }
  }

  const categories = new Map<string, TagItem[]>();
  for (const { tag, count } of counts.values()) {
    const label = tagCategoryLabel(tag);
    const list = categories.get(label) ?? [];
    list.push({ tag, count });
    categories.set(label, list);
  }

  const order = ["Styles", "Mood", "Voices", "Instruments", "Other"];
  return order
    .map((label) => ({
      label,
      tags: (categories.get(label) ?? []).sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag)),
    }))
    .filter((category) => category.tags.length > 0);
}

function songMatchesSelectedTags(song: Song, selectedTagKeys: Set<string>): boolean {
  if (selectedTagKeys.size === 0) {
    return true;
  }
  const songTagKeys = new Set(song.tags.map(tagKey));
  return Array.from(selectedTagKeys).every((key) => songTagKeys.has(key));
}

function uniqueSongsById(songs: Song[]): Song[] {
  const byId = new Map<string, Song>();
  for (const song of songs) {
    byId.set(song.id, song);
  }
  return Array.from(byId.values());
}

function tagKey(tag: string): string {
  return tag.trim().toLowerCase();
}

function tagCategoryLabel(tag: string): string {
  const normalized = tag.toLowerCase();
  if (VOICE_TAG_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return "Voices";
  }
  if (INSTRUMENT_TAGS.has(normalized) || Array.from(INSTRUMENT_TAGS).some((instrument) => normalized.includes(instrument))) {
    return "Instruments";
  }
  if (MOOD_TAGS.has(normalized)) {
    return "Mood";
  }
  if (normalized.startsWith("no ")) {
    return "Other";
  }
  return "Styles";
}

const styles = StyleSheet.create({
  eyebrow: {
    color: theme.colors.tint,
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 0,
  },
  title: {
    color: theme.colors.text,
    fontSize: 42,
    fontWeight: "900",
  },
  hero: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    flexDirection: "row",
    gap: 14,
    padding: 12,
  },
  heroCopy: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  heroLabel: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "900",
  },
  heroTitle: {
    color: theme.colors.text,
    flexShrink: 1,
    fontSize: 23,
    fontWeight: "900",
  },
  heroMeta: {
    color: theme.colors.secondaryText,
    fontSize: 13,
  },
  generateButton: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: theme.radius.pill,
    justifyContent: "center",
    minHeight: 38,
    minWidth: 98,
    paddingHorizontal: 14,
  },
  generateButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "900",
  },
  disabled: {
    opacity: 0.52,
  },
  cardGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  dailyCard: {
    backgroundColor: theme.colors.surface,
    borderColor: "transparent",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    flexBasis: "31%",
    flex: 1,
    gap: 6,
    minWidth: 108,
    minHeight: 142,
    padding: 12,
  },
  dailyCardActive: {
    backgroundColor: theme.colors.tintSoft,
    borderColor: theme.colors.tint,
  },
  cardLabel: {
    color: theme.colors.tint,
    fontSize: 11,
    fontWeight: "900",
  },
  cardTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "900",
  },
  cardSubtitle: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    lineHeight: 16,
  },
  cardMeta: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "800",
    marginTop: "auto",
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "900",
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 24,
  },
  historyGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  historyCard: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    minWidth: 118,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  historyCardActive: {
    backgroundColor: theme.colors.tintSoft,
    borderColor: theme.colors.tint,
  },
  loadingMoreText: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "900",
    textAlign: "center",
  },
  historyDate: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "900",
  },
  historyMeta: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    marginTop: 3,
  },
  tagCategoryList: {
    gap: 10,
  },
  tagCategory: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    gap: 10,
    padding: 12,
  },
  tagCategoryHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  tagCategoryTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "900",
  },
  tagCategoryCount: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "900",
  },
  clearTagButton: {
    alignItems: "center",
    backgroundColor: theme.colors.tintSoft,
    borderColor: theme.colors.tint,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 30,
    justifyContent: "center",
    paddingHorizontal: 11,
  },
  clearTagText: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "900",
  },
  tagWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tagPill: {
    alignItems: "center",
    backgroundColor: theme.colors.elevated,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 10,
  },
  tagPillActive: {
    backgroundColor: theme.colors.tint,
    borderColor: theme.colors.tint,
  },
  tagText: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: "800",
  },
  tagTextActive: {
    color: "#FFFFFF",
  },
  tagCount: {
    color: theme.colors.tint,
    fontSize: 11,
    fontWeight: "900",
  },
  list: {
    gap: 8,
  },
  trackRow: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    flexDirection: "row",
    gap: 11,
    minHeight: 64,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  trackCopy: {
    flex: 1,
    minWidth: 0,
  },
  trackTitleLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    minWidth: 0,
  },
  trackTitle: {
    color: theme.colors.text,
    flexShrink: 1,
    fontSize: 15,
    fontWeight: "800",
  },
  trackMeta: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    marginTop: 3,
  },
  duration: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "800",
  },
  trailing: {
    alignItems: "flex-end",
    gap: 2,
    minWidth: 54,
  },
  likeBadge: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "900",
    lineHeight: 14,
  },
  cached: {
    color: theme.colors.tint,
  },
  emptyPanel: {
    alignItems: "flex-start",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    gap: 5,
    minHeight: 82,
    justifyContent: "center",
    padding: 14,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "900",
  },
  emptyMeta: {
    color: theme.colors.secondaryText,
    fontSize: 13,
  },
  errorText: {
    color: theme.colors.tint,
    fontSize: 13,
    fontWeight: "800",
  },
  pressed: {
    opacity: 0.78,
  },
});
