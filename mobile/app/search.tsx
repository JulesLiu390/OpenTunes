import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useAuth } from "@/components/AuthProvider";
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
  saveSongListCache,
  songListCacheKey,
  songTagSummary,
} from "@/lib/songs";
import { artworkPalettes, theme } from "@/lib/theme";

const SEARCH_PAGE_SIZE = 50;
const END_REACHED_THRESHOLD = 220;

export default function SearchScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const { busySongId, currentSong, isPlaying, playSong, updateCurrentSongLike } = usePlayer();
  const [cacheStatus, setCacheStatus] = useState<Record<string, SongCacheStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageInfo, setPageInfo] = useState({
    total: 0,
    nextOffset: 0,
    hasMore: false,
  });
  const [query, setQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [songs, setSongs] = useState<Song[]>([]);
  const [endReachedArmed, setEndReachedArmed] = useState(true);

  async function submitSearch() {
    const search = query.trim();
    if (!session || !search || loading) {
      return;
    }

    setLoading(true);
    setError(null);
    setSearchedQuery(search);
    setSongs([]);
    setPageInfo({ total: 0, nextOffset: 0, hasMore: false });
    try {
      const response = await listSongs(session.accessToken, SEARCH_PAGE_SIZE, 0, { q: search });
      const cached = await saveSongListCache(session.user.id, songListCacheKey("search", search.toLowerCase()), response);
      setSongs(cached.songs);
      setPageInfo({
        total: cached.total,
        nextOffset: cached.nextOffset,
        hasMore: cached.hasMore,
      });
      setCacheStatus(await getSongCacheStatuses(cached.songs));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Search could not load.");
    } finally {
      setLoading(false);
    }
  }

  async function loadMoreResults() {
    const search = searchedQuery.trim();
    if (!session || !search || loading || loadingMore || !pageInfo.hasMore) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      const response = await listSongs(session.accessToken, SEARCH_PAGE_SIZE, pageInfo.nextOffset, { q: search });
      const cached = await saveSongListCache(session.user.id, songListCacheKey("search", search.toLowerCase()), response, {
        append: true,
      });
      setSongs(cached.songs);
      setPageInfo({
        total: cached.total,
        nextOffset: cached.nextOffset,
        hasMore: cached.hasMore,
      });
      setCacheStatus(await getSongCacheStatuses(cached.songs));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "More songs could not load.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function selectSong(song: Song) {
    if (!session || cacheStatus[song.id] === "downloading") {
      return;
    }
    try {
      const result = await playSong(song, songs, { source: "library" });
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

  function handleBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/library" as never);
  }

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    if (distanceFromEnd <= END_REACHED_THRESHOLD) {
      if (endReachedArmed) {
        setEndReachedArmed(false);
        loadMoreResults();
      }
      return;
    }
    if (distanceFromEnd > END_REACHED_THRESHOLD * 1.5 && !endReachedArmed) {
      setEndReachedArmed(true);
    }
  }

  const canSearch = Boolean(session && query.trim() && !loading);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => setEndReachedArmed(true)}
        onScroll={handleScroll}
        scrollEventThrottle={120}
        showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Back to library"
            accessibilityRole="button"
            onPress={handleBack}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}>
            <Text style={styles.backIcon}>‹</Text>
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>Library</Text>
            <Text style={styles.title}>Search</Text>
          </View>
        </View>

        <View style={styles.searchPanel}>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            clearButtonMode="while-editing"
            onChangeText={setQuery}
            onSubmitEditing={submitSearch}
            placeholder="Song, artist, album, or tag"
            placeholderTextColor={theme.colors.tertiaryText}
            returnKeyType="search"
            style={styles.searchInput}
            value={query}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!canSearch}
            onPress={submitSearch}
            style={({ pressed }) => [styles.searchButton, !canSearch && styles.disabled, pressed && styles.pressed]}>
            {loading ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Text style={styles.searchButtonText}>Search</Text>}
          </Pressable>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {searchedQuery ? (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Results</Text>
            <Text style={styles.sectionMeta}>
              {pageInfo.total > songs.length ? `${songs.length}/${pageInfo.total} songs` : `${songs.length} songs`}
            </Text>
          </View>
        ) : null}

        <View style={styles.list}>
          {songs.length ? (
            songs.map((song, index) => {
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
            })
          ) : searchedQuery && !loading ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No Songs Found</Text>
              <Text style={styles.emptyText}>Try another title, artist, album, or tag.</Text>
            </View>
          ) : null}
          {loadingMore ? (
            <View style={styles.loadingMoreRow}>
              <Text style={styles.loadingMoreText}>Loading more</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
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

const styles = StyleSheet.create({
  safe: {
    backgroundColor: theme.colors.background,
    flex: 1,
  },
  content: {
    gap: 16,
    paddingBottom: 28,
    paddingHorizontal: 20,
    paddingTop: 36,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
  },
  backButton: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  backIcon: {
    color: theme.colors.text,
    fontSize: 30,
    fontWeight: "900",
    lineHeight: 32,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
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
  searchPanel: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  searchInput: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    color: theme.colors.text,
    flex: 1,
    fontSize: 15,
    fontWeight: "800",
    minHeight: 48,
    paddingHorizontal: 14,
  },
  searchButton: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: theme.radius.pill,
    minHeight: 48,
    justifyContent: "center",
    minWidth: 86,
    paddingHorizontal: 16,
  },
  searchButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "900",
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "900",
  },
  sectionMeta: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "800",
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
  emptyState: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    gap: 4,
    minHeight: 84,
    justifyContent: "center",
    padding: 16,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "900",
  },
  emptyText: {
    color: theme.colors.secondaryText,
    fontSize: 13,
    fontWeight: "700",
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
  errorText: {
    color: theme.colors.tint,
    fontSize: 13,
    fontWeight: "800",
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.75,
  },
});
