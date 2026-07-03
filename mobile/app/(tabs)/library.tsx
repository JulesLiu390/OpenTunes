import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Section } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { MusicPage } from "@/components/MusicPage";
import { usePlayer } from "@/components/PlayerProvider";
import { SongActionMenu } from "@/components/SongActionMenu";
import { SongListRow } from "@/components/SongListRow";
import {
  Song,
  SongCacheStatus,
  cacheSong,
  deleteCachedSong,
  formatDuration,
  getSongCacheStatuses,
  listSongs,
  loadSongListCache,
  loadCachedSongs,
  saveSongListCache,
  songListCacheKey,
  songTagSummary,
} from "@/lib/songs";
import { artworkPalettes, theme } from "@/lib/theme";

const LIBRARY_PAGE_SIZE = 50;
const LIBRARY_CACHE_KEY = songListCacheKey("library");

export default function LibraryScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const { busySongId, currentSong, isPlaying, playSong, updateCurrentSongLike } = usePlayer();
  const [songs, setSongs] = useState<Song[]>([]);
  const [cacheStatus, setCacheStatus] = useState<Record<string, SongCacheStatus>>({});
  const [tagBrowserOpen, setTagBrowserOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagSort, setTagSort] = useState<TagSort>("count");
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageInfo, setPageInfo] = useState({
    total: 0,
    nextOffset: 0,
    hasMore: false,
    isStale: false,
  });
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [playerTrack, setPlayerTrack] = useState({
    title: "Lake Light",
    subtitle: "Suno Sketch",
  });

  useEffect(() => {
    let mounted = true;

    async function loadInitialSongs() {
      if (!session) {
        setSongs([]);
        setCacheStatus({});
        setPageInfo({ total: 0, nextOffset: 0, hasMore: false, isStale: false });
        return;
      }
      const cachedList = await loadSongListCache(session.user.id, LIBRARY_CACHE_KEY);
      if (mounted && cachedList) {
        setSongs(cachedList.songs);
        setPageInfo({
          total: cachedList.total,
          nextOffset: cachedList.nextOffset,
          hasMore: cachedList.hasMore,
          isStale: cachedList.isStale,
        });
        setCacheStatus(await getSongCacheStatuses(cachedList.songs));
        setSyncMessage(cachedList.isStale ? "Cached library shown. Refreshing changes." : null);
      }
      try {
        const response = await listSongs(session.accessToken, LIBRARY_PAGE_SIZE, 0);
        const cached = await saveSongListCache(session.user.id, LIBRARY_CACHE_KEY, response);
        const statuses = await getSongCacheStatuses(cached.songs);
        if (mounted) {
          setSongs(cached.songs);
          setCacheStatus(statuses);
          setPageInfo({
            total: cached.total,
            nextOffset: cached.nextOffset,
            hasMore: cached.hasMore,
            isStale: cached.isStale,
          });
          setSyncMessage(null);
        }
      } catch {
        if (!cachedList) {
          const cachedSongs = await loadCachedSongs(session.user.id);
          const statuses = await getSongCacheStatuses(cachedSongs);
          if (mounted) {
            setSongs(cachedSongs);
            setCacheStatus(statuses);
            setPageInfo({
              total: cachedSongs.length,
              nextOffset: cachedSongs.length,
              hasMore: false,
              isStale: false,
            });
            setSyncMessage(cachedSongs.length ? "Offline library loaded from this phone." : "Library could not load.");
          }
        }
      }
    }

    loadInitialSongs();

    return () => {
      mounted = false;
    };
  }, [session]);

  async function loadMoreSongs() {
    if (!session || loadingMore || !pageInfo.hasMore) {
      return;
    }
    setLoadingMore(true);
    setSyncMessage(null);
    try {
      const response = await listSongs(session.accessToken, LIBRARY_PAGE_SIZE, pageInfo.nextOffset);
      const cached = await saveSongListCache(session.user.id, LIBRARY_CACHE_KEY, response, { append: true });
      const statuses = await getSongCacheStatuses(cached.songs);
      setSongs(cached.songs);
      setCacheStatus(statuses);
      setPageInfo({
        total: cached.total,
        nextOffset: cached.nextOffset,
        hasMore: cached.hasMore,
        isStale: cached.isStale,
      });
    } catch (exc) {
      setSyncMessage(exc instanceof Error ? exc.message : "More songs could not load.");
    } finally {
      setLoadingMore(false);
    }
  }

  const tagFacets = useMemo(() => buildTagFacets(songs, tagSort), [songs, tagSort]);
  const selectedTagKeys = useMemo(() => new Set(selectedTags.map(tagKey)), [selectedTags]);
  const visibleSongs = useMemo(() => {
    if (selectedTagKeys.size === 0) {
      return songs;
    }
    return songs.filter((song) => song.tags.some((tag) => selectedTagKeys.has(tagKey(tag))));
  }, [selectedTagKeys, songs]);

  useEffect(() => {
    const facetKeys = new Set(tagFacets.map((item) => tagKey(item.tag)));
    setSelectedTags((current) => current.filter((tag) => facetKeys.has(tagKey(tag))));
  }, [tagFacets]);

  async function selectSong(song: Song) {
    setPlayerTrack({ title: song.title, subtitle: songTagSummary(song) });
    if (!session || cacheStatus[song.id] === "downloading") {
      return;
    }

    try {
      const result = await playSong(song, undefined, { source: "library" });
      if (result) {
        setCacheStatus((current) => ({ ...current, [song.id]: result.cached ? "cached" : "remote" }));
      } else if (cacheStatus[song.id] !== "cached") {
        setCacheStatus((current) => ({ ...current, [song.id]: "remote" }));
      }
    } catch {
      setCacheStatus((current) => ({ ...current, [song.id]: "remote" }));
    }
  }

  async function downloadSong(song: Song) {
    if (!session || cacheStatus[song.id] === "downloading") {
      return;
    }
    setCacheStatus((current) => ({ ...current, [song.id]: "downloading" }));
    try {
      const result = await cacheSong(song, session.accessToken);
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
    setSongs((current) =>
      current.map((song) => (song.id === songId ? { ...song, is_liked: isLiked, liked_at: likedAt } : song)),
    );
    updateCurrentSongLike(songId, isLiked, likedAt);
  }

  function toggleTag(tag: string) {
    const key = tagKey(tag);
    setSelectedTags((current) =>
      current.some((item) => tagKey(item) === key) ? current.filter((item) => tagKey(item) !== key) : [...current, tag],
    );
  }

  const hasRemoteSongs = songs.length > 0;
  const selectedTitle = selectedTagsTitle(selectedTags);

  return (
    <MusicPage
      onEndReached={pageInfo.hasMore && selectedTagKeys.size === 0 ? loadMoreSongs : undefined}
      playerTitle={playerTrack.title}
      playerSubtitle={playerTrack.subtitle}>
      <Section>
        <Text style={styles.eyebrow}>Collection</Text>
        <Text style={styles.title}>Library</Text>
      </Section>

      <Section>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/search" as never)}
          style={({ pressed }) => [styles.searchButton, pressed && styles.pressed]}>
          <Text style={styles.searchPlaceholder}>Search songs</Text>
          <Text style={styles.searchIcon}>⌕</Text>
        </Pressable>
      </Section>

      {syncMessage ? (
        <Section>
          <Text style={styles.syncMessage}>{syncMessage}</Text>
        </Section>
      ) : null}

      {hasRemoteSongs ? (
        <Section>
          <View style={styles.libraryGrid}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setTagBrowserOpen(true)}
              style={({ pressed }) => [styles.libraryTile, pressed && styles.pressed]}>
              <Text style={styles.tileLabel}>Tags</Text>
              <Text style={styles.tileTitle} numberOfLines={2}>
                {selectedTitle ?? "Tags"}
              </Text>
              <Text style={styles.tileMeta}>
                {selectedTags.length ? `${visibleSongs.length} songs` : `${tagFacets.length} tags`}
              </Text>
            </Pressable>
          </View>
        </Section>
      ) : null}

      {hasRemoteSongs && tagBrowserOpen ? (
        <Section>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Tags</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setTagBrowserOpen(false)}
              style={({ pressed }) => [styles.closeTextButton, pressed && styles.pressed]}>
              <Text style={styles.closeText}>Done</Text>
            </Pressable>
          </View>
          <View style={styles.sortControl}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setTagSort("count")}
              style={({ pressed }) => [styles.sortButton, tagSort === "count" && styles.sortButtonActive, pressed && styles.pressed]}>
              <Text style={[styles.sortText, tagSort === "count" && styles.sortTextActive]}>Song Count</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setTagSort("az")}
              style={({ pressed }) => [styles.sortButton, tagSort === "az" && styles.sortButtonActive, pressed && styles.pressed]}>
              <Text style={[styles.sortText, tagSort === "az" && styles.sortTextActive]}>A-Z</Text>
            </Pressable>
          </View>
          <View style={styles.tagList}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setSelectedTags([])}
              style={({ pressed }) => [styles.tagRow, selectedTags.length === 0 && styles.tagRowActive, pressed && styles.pressed]}>
              <Text style={[styles.tagRowTitle, selectedTags.length === 0 && styles.tagRowTitleActive]}>All Tags</Text>
              <Text style={[styles.tagRowCount, selectedTags.length === 0 && styles.tagRowCountActive]}>{songs.length}</Text>
            </Pressable>
            {tagFacets.map((item) => {
              const active = selectedTagKeys.has(tagKey(item.tag));
              return (
                <Pressable
                  accessibilityRole="button"
                  key={item.tag}
                  onPress={() => toggleTag(item.tag)}
                  style={({ pressed }) => [styles.tagRow, active && styles.tagRowActive, pressed && styles.pressed]}>
                  <Text style={[styles.tagRowTitle, active && styles.tagRowTitleActive]} numberOfLines={1}>
                    {item.tag}
                  </Text>
                  <Text style={[styles.tagRowCount, active && styles.tagRowCountActive]}>{item.count}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>
      ) : null}

      {hasRemoteSongs ? (
        <Section>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{selectedTitle ?? "Recently Added"}</Text>
            <Text style={styles.sectionMeta}>
              {pageInfo.total > visibleSongs.length && selectedTagKeys.size === 0
                ? `${visibleSongs.length}/${pageInfo.total} songs`
                : `${visibleSongs.length} songs`}
            </Text>
          </View>
          <View style={styles.list}>
            {visibleSongs.map((song, index) => {
              const displaySong = currentSong?.id === song.id ? currentSong : song;
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
                  subtitle={songTagSummary(displaySong)}
                />
              );
            })}
            {loadingMore ? (
              <View style={styles.loadingMoreRow}>
                <Text style={styles.loadingMoreText}>Loading more</Text>
              </View>
            ) : null}
          </View>
        </Section>
      ) : null}
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

type TagFacet = {
  tag: string;
  count: number;
};

type TagSort = "count" | "az";

function buildTagFacets(songs: Song[], sort: TagSort): TagFacet[] {
  const counts = new Map<string, TagFacet>();
  for (const song of songs) {
    for (const rawTag of song.tags) {
      const tag = rawTag.trim();
      if (!tag) {
        continue;
      }
      const key = tagKey(tag);
      const current = counts.get(key);
      if (current) {
        current.count += 1;
      } else {
        counts.set(key, { tag, count: 1 });
      }
    }
  }
  return Array.from(counts.values()).sort((left, right) => {
    if (sort === "az") {
      return left.tag.localeCompare(right.tag) || right.count - left.count;
    }
    return right.count - left.count || left.tag.localeCompare(right.tag);
  });
}

function tagKey(tag: string): string {
  return tag.trim().toLowerCase();
}

function selectedTagsTitle(tags: string[]): string | null {
  if (tags.length === 0) {
    return null;
  }
  if (tags.length === 1) {
    return tags[0];
  }
  return `${tags.length} Tags`;
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
  syncMessage: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    fontWeight: "800",
  },
  searchButton: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: 14,
  },
  searchPlaceholder: {
    color: theme.colors.tertiaryText,
    fontSize: 15,
    fontWeight: "800",
  },
  searchIcon: {
    color: theme.colors.tint,
    fontSize: 22,
    fontWeight: "900",
    lineHeight: 24,
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
  },
  sectionMeta: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "800",
  },
  libraryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  libraryTile: {
    aspectRatio: 1,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexBasis: "48%",
    flexGrow: 1,
    justifyContent: "space-between",
    maxWidth: 180,
    minHeight: 156,
    padding: 14,
  },
  tileLabel: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "900",
  },
  tileTitle: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: "900",
  },
  tileMeta: {
    color: theme.colors.secondaryText,
    fontSize: 13,
    fontWeight: "800",
  },
  closeTextButton: {
    alignItems: "center",
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  closeText: {
    color: theme.colors.tint,
    fontSize: 13,
    fontWeight: "900",
  },
  sortControl: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    padding: 3,
  },
  sortButton: {
    alignItems: "center",
    borderRadius: theme.radius.pill,
    flex: 1,
    minHeight: 34,
    justifyContent: "center",
  },
  sortButtonActive: {
    backgroundColor: theme.colors.tintSoft,
  },
  sortText: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    fontWeight: "900",
  },
  sortTextActive: {
    color: theme.colors.tint,
  },
  tagList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tagRow: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 7,
    minHeight: 36,
    maxWidth: "100%",
    paddingHorizontal: 12,
  },
  tagRowActive: {
    backgroundColor: theme.colors.tintSoft,
    borderColor: theme.colors.tint,
  },
  tagRowTitle: {
    color: theme.colors.text,
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "900",
  },
  tagRowTitleActive: {
    color: theme.colors.tint,
  },
  tagRowCount: {
    color: theme.colors.tertiaryText,
    fontSize: 11,
    fontWeight: "900",
  },
  tagRowCountActive: {
    color: theme.colors.tint,
  },
  list: {
    gap: 8,
  },
  row: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    flexDirection: "row",
    gap: 12,
    minHeight: 78,
    padding: 10,
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
  },
  titleLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    minWidth: 0,
  },
  rowTitle: {
    color: theme.colors.text,
    flexShrink: 1,
    fontSize: 16,
    fontWeight: "900",
  },
  likeBadge: {
    color: theme.colors.tint,
    fontSize: 13,
    fontWeight: "900",
    lineHeight: 14,
  },
  rowDetail: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    marginTop: 4,
  },
  loadingMoreRow: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 32,
  },
  loadingMoreText: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "900",
  },
  disabled: {
    opacity: 0.52,
  },
  pressed: {
    opacity: 0.78,
  },
});
