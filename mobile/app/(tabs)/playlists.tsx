import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { AlbumArt } from "@/components/AlbumArt";
import { Section } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { MusicPage } from "@/components/MusicPage";
import { usePlayer } from "@/components/PlayerProvider";
import { SongActionMenu } from "@/components/SongActionMenu";
import { SongArtwork } from "@/components/SongArtwork";
import { SongListRow } from "@/components/SongListRow";
import {
  createPlaylist,
  getPlaylist,
  listPlaylists,
  loadCachedPlaylistDetail,
  loadCachedPlaylists,
  PlaylistDetail,
  PlaylistSummary,
  updatePlaylist,
} from "@/lib/playlists";
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
  mergeSongCatalog,
  saveSongListCache,
  songListCacheKey,
  songTagSummary,
} from "@/lib/songs";
import { artworkPalettes, theme } from "@/lib/theme";

const CATALOG_PAGE_SIZE = 50;
const CATALOG_CACHE_KEY = songListCacheKey("library");

export default function PlaylistsScreen() {
  const { session } = useAuth();
  const { busySongId, currentSong, isPlaying, playSong, updateCurrentSongLike } = usePlayer();
  const [catalogSongs, setCatalogSongs] = useState<Song[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistDetail | null>(null);
  const [editCoverSongId, setEditCoverSongId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingCatalogMore, setLoadingCatalogMore] = useState(false);
  const [newName, setNewName] = useState("");
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistDetail | null>(null);
  const [cacheStatus, setCacheStatus] = useState<Record<string, SongCacheStatus>>({});
  const [catalogPageInfo, setCatalogPageInfo] = useState({
    total: 0,
    nextOffset: 0,
    hasMore: false,
  });

  const selectedPlaylistId = selectedPlaylist?.id;

  useFocusEffect(
    useCallback(() => {
      let mounted = true;

      async function load() {
        if (!session) {
          setCatalogSongs([]);
          setPlaylists([]);
          setSelectedPlaylist(null);
          setCacheStatus({});
          setLoading(false);
          return;
        }
        setLoading(true);
        const cachedPlaylists = await loadCachedPlaylists(session.user.id);
        const cachedCatalog = await loadSongListCache(session.user.id, CATALOG_CACHE_KEY);
        const cachedSelected = selectedPlaylistId
          ? await loadCachedPlaylistDetail(session.user.id, selectedPlaylistId)
          : null;
        if (mounted) {
          if (cachedPlaylists) {
            setPlaylists(cachedPlaylists.playlists);
          }
          if (cachedCatalog) {
            setCatalogSongs(cachedCatalog.songs);
            setCatalogPageInfo({
              total: cachedCatalog.total,
              nextOffset: cachedCatalog.nextOffset,
              hasMore: cachedCatalog.hasMore,
            });
          }
          if (cachedSelected) {
            setSelectedPlaylist(cachedSelected);
          }
          const statusSongs = [...(cachedCatalog?.songs ?? []), ...(cachedSelected?.songs ?? [])];
          if (statusSongs.length) {
            setCacheStatus(await getSongCacheStatuses(statusSongs));
          }
        }
        try {
          const [playlistResponse, songResponse] = await Promise.all([
            listPlaylists(session.accessToken),
            listSongs(session.accessToken, CATALOG_PAGE_SIZE, 0),
          ]);
          if (!mounted) {
            return;
          }
          const nextSelected = selectedPlaylistId
            ? playlistResponse.playlists.find((playlist) => playlist.id === selectedPlaylistId)
            : undefined;
          const nextSelectedDetail = nextSelected ? await getPlaylist(session.accessToken, nextSelected.id) : null;
          const statusSongs = [...songResponse.songs, ...(nextSelectedDetail?.songs ?? [])];
          const cachedSongList = await saveSongListCache(session.user.id, CATALOG_CACHE_KEY, songResponse);
          await mergeSongCatalog(session.user.id, statusSongs);
          const statuses = await getSongCacheStatuses(statusSongs);
          if (!mounted) {
            return;
          }
          setCatalogSongs(cachedSongList.songs);
          setCatalogPageInfo({
            total: cachedSongList.total,
            nextOffset: cachedSongList.nextOffset,
            hasMore: cachedSongList.hasMore,
          });
          setPlaylists(playlistResponse.playlists);
          setSelectedPlaylist(nextSelectedDetail);
          setCacheStatus(statuses);
        } catch {
          if (!cachedPlaylists && !cachedCatalog) {
            const cachedSongs = session ? await loadCachedSongs(session.user.id) : [];
            const statuses = await getSongCacheStatuses(cachedSongs);
            if (mounted) {
              setCatalogSongs(cachedSongs);
              setPlaylists([]);
              setSelectedPlaylist(null);
              setCacheStatus(statuses);
              setCatalogPageInfo({
                total: cachedSongs.length,
                nextOffset: cachedSongs.length,
                hasMore: false,
              });
            }
          }
        } finally {
          if (mounted) {
            setLoading(false);
          }
        }
      }

      load();

      return () => {
        mounted = false;
      };
    }, [selectedPlaylistId, session]),
  );

  const availableSongs = useMemo(() => {
    const selectedIds = new Set(selectedPlaylist?.songs.map((song) => song.id) ?? []);
    return catalogSongs.filter((song) => !selectedIds.has(song.id)).slice(0, 8);
  }, [catalogSongs, selectedPlaylist]);
  const catalogSongById = useMemo(() => new Map(catalogSongs.map((song) => [song.id, song])), [catalogSongs]);
  const selectedCoverSong = useMemo(
    () => (selectedPlaylist ? playlistDetailCoverSong(selectedPlaylist) : null),
    [selectedPlaylist],
  );

  async function refreshPlaylists(selectedId?: string) {
    if (!session) {
      return;
    }
    const playlistResponse = await listPlaylists(session.accessToken);
    setPlaylists(playlistResponse.playlists);
    const nextSelected = selectedId
      ? playlistResponse.playlists.find((playlist) => playlist.id === selectedId)
      : playlistResponse.playlists.find((playlist) => playlist.id === selectedPlaylist?.id);
    if (nextSelected) {
      const detail = await getPlaylist(session.accessToken, nextSelected.id);
      await mergeSongCatalog(session.user.id, detail.songs);
      const statuses = await getSongCacheStatuses(detail.songs);
      setSelectedPlaylist(detail);
      setCacheStatus((current) => ({ ...current, ...statuses }));
    } else {
      setSelectedPlaylist(null);
    }
  }

  async function submitPlaylist() {
    const name = newName.trim();
    if (!session || !name || creating) {
      return;
    }
    setCreating(true);
    try {
      const playlist = await createPlaylist(session.accessToken, name);
      setNewName("");
      setCreateOpen(false);
      await refreshPlaylists(playlist.id);
    } finally {
      setCreating(false);
    }
  }

  async function openPlaylistEditor(playlist: PlaylistSummary | PlaylistDetail) {
    if (!session || playlist.is_system) {
      return;
    }
    setEditError(null);
    let detail: PlaylistDetail | null = selectedPlaylist?.id === playlist.id ? selectedPlaylist : null;
    if (!detail) {
      detail = await loadCachedPlaylistDetail(session.user.id, playlist.id);
    }
    if (!detail) {
      detail = await getPlaylist(session.accessToken, playlist.id);
    }
    setEditingPlaylist(detail);
    setEditName(detail.name);
    setEditCoverSongId(playlistDetailCoverSong(detail)?.id ?? null);
  }

  function closePlaylistEditor() {
    if (savingEdit) {
      return;
    }
    setEditingPlaylist(null);
    setEditCoverSongId(null);
    setEditError(null);
    setEditName("");
  }

  async function submitPlaylistEdit() {
    const target = editingPlaylist;
    const name = editName.trim();
    if (!session || !target || !name || savingEdit) {
      return;
    }
    setSavingEdit(true);
    setEditError(null);
    try {
      const detail = await updatePlaylist(session.accessToken, target.id, {
        name,
        cover_song_id: editCoverSongId,
      });
      setSelectedPlaylist(detail);
      setPlaylists((current) => current.map((playlist) => (playlist.id === detail.id ? detail : playlist)));
      setEditingPlaylist(null);
      setEditName("");
      setEditCoverSongId(null);
      await refreshPlaylists(detail.id).catch(() => undefined);
    } catch (exc) {
      setEditError(exc instanceof Error ? exc.message : "Playlist could not be updated.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function selectPlaylist(playlist: PlaylistSummary) {
    if (selectedPlaylist?.id === playlist.id) {
      setSelectedPlaylist(null);
      return;
    }
    if (!session) {
      return;
    }
    const cachedDetail = await loadCachedPlaylistDetail(session.user.id, playlist.id);
    if (cachedDetail) {
      setSelectedPlaylist(cachedDetail);
      setCacheStatus((current) => ({
        ...current,
        ...Object.fromEntries(cachedDetail.songs.map((song) => [song.id, current[song.id] ?? "remote"])),
      }));
    }
    const detail = await getPlaylist(session.accessToken, playlist.id);
    await mergeSongCatalog(session.user.id, detail.songs);
    const statuses = await getSongCacheStatuses(detail.songs);
    setSelectedPlaylist(detail);
    setCacheStatus((current) => ({ ...current, ...statuses }));
  }

  async function loadMoreCatalogSongs() {
    if (!session || loadingCatalogMore || !catalogPageInfo.hasMore) {
      return;
    }
    setLoadingCatalogMore(true);
    try {
      const response = await listSongs(session.accessToken, CATALOG_PAGE_SIZE, catalogPageInfo.nextOffset);
      const cached = await saveSongListCache(session.user.id, CATALOG_CACHE_KEY, response, { append: true });
      const statuses = await getSongCacheStatuses(cached.songs);
      setCatalogSongs(cached.songs);
      setCatalogPageInfo({
        total: cached.total,
        nextOffset: cached.nextOffset,
        hasMore: cached.hasMore,
      });
      setCacheStatus((current) => ({ ...current, ...statuses }));
    } finally {
      setLoadingCatalogMore(false);
    }
  }

  async function playFromPlaylist(song: Song) {
    if (!selectedPlaylist) {
      return;
    }
    try {
      const result = await playSong(song, selectedPlaylist.songs, { playlistId: selectedPlaylist.id, source: "playlist" });
      if (result) {
        setCacheStatus((current) => ({ ...current, [song.id]: result.cached ? "cached" : "remote" }));
      } else if (cacheStatus[song.id] !== "cached") {
        setCacheStatus((current) => ({ ...current, [song.id]: "remote" }));
      }
    } catch {
      setCacheStatus((current) => ({ ...current, [song.id]: "remote" }));
    }
  }

  async function playSelectedPlaylist() {
    const firstSong = selectedPlaylist?.songs[0];
    if (!firstSong) {
      return;
    }
    await playFromPlaylist(firstSong);
  }

  async function downloadSong(song: Song) {
    if (!session || cacheStatus[song.id] === "downloading") {
      return;
    }
    setCacheStatus((current) => ({ ...current, [song.id]: "downloading" }));
    try {
      const result = await cacheSong(song, session.accessToken);
      await mergeSongCatalog(session.user.id, [song]);
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
    setCatalogSongs((current) =>
      current.map((song) => (song.id === songId ? { ...song, is_liked: isLiked, liked_at: likedAt } : song)),
    );
    setSelectedPlaylist((current) => {
      if (!current) {
        return current;
      }
      if (current.is_system && !isLiked) {
        return {
          ...current,
          song_count: Math.max(0, current.song_count - 1),
          songs: current.songs.filter((song) => song.id !== songId),
        };
      }
      return {
        ...current,
        songs: current.songs.map((song) => (song.id === songId ? { ...song, is_liked: isLiked, liked_at: likedAt } : song)),
      };
    });
    updateCurrentSongLike(songId, isLiked, likedAt);
  }

  async function refreshAfterPlaylistChange() {
    await refreshPlaylists(selectedPlaylist?.id);
  }

  const heroSong = selectedCoverSong;
  const selectedIsSystem = Boolean(selectedPlaylist?.is_system);

  return (
    <MusicPage
      onEndReached={selectedPlaylist && !selectedIsSystem && catalogPageInfo.hasMore ? loadMoreCatalogSongs : undefined}>
      <Section>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>Your Mixes</Text>
            <Text style={styles.title}>Play Lists</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => setCreateOpen((open) => !open)}
            style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
            <Text style={styles.addIcon}>＋</Text>
          </Pressable>
        </View>
      </Section>

      {createOpen ? (
        <Section>
          <View style={styles.createPanel}>
            <TextInput
              autoCapitalize="words"
              onChangeText={setNewName}
              placeholder="Playlist name"
              placeholderTextColor={theme.colors.tertiaryText}
              style={styles.input}
              value={newName}
            />
            <Pressable
              disabled={!newName.trim() || creating}
              onPress={submitPlaylist}
              style={({ pressed }) => [styles.createButton, pressed && styles.pressed, (!newName.trim() || creating) && styles.disabled]}>
              <Text style={styles.createButtonText}>{creating ? "Creating" : "Create"}</Text>
            </Pressable>
          </View>
        </Section>
      ) : null}

      <Section>
        <Pressable
          onLongPress={selectedPlaylist && !selectedIsSystem ? () => openPlaylistEditor(selectedPlaylist) : undefined}
          style={({ pressed }) => [styles.featured, pressed && selectedPlaylist && !selectedIsSystem && styles.pressed]}>
          {heroSong ? (
            <SongArtwork accessToken={session?.accessToken ?? null} colors={artworkPalettes[3]} size={96} song={heroSong} />
          ) : (
            <AlbumArt colors={artworkPalettes[3]} size={96} />
          )}
          <View style={styles.featuredCopy}>
            <Text style={styles.featuredLabel}>Selected List</Text>
            <Text style={styles.featuredTitle} numberOfLines={1}>
              {selectedPlaylist?.name ?? "No List Selected"}
            </Text>
            <Text style={styles.featuredMeta} numberOfLines={2}>
              {selectedPlaylist
                ? `${selectedPlaylist.song_count} songs · ${selectedIsSystem ? "System list" : "Personal list"}`
                : playlists.length
                  ? "Select a list to view songs"
                  : "Create a list and add songs from your library"}
            </Text>
          </View>
          {selectedPlaylist?.songs.length ? (
            <Pressable
              accessibilityLabel="Play selected playlist"
              accessibilityRole="button"
              onPress={playSelectedPlaylist}
              style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}>
              <Text style={styles.playButtonText}>Play All</Text>
            </Pressable>
          ) : null}
        </Pressable>
      </Section>

      <Section>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>All Play Lists</Text>
          {loading ? <ActivityIndicator color={theme.colors.tint} size="small" /> : null}
        </View>
        <View style={styles.grid}>
          {playlists.map((playlist, index) => (
            <Pressable
              key={playlist.id}
              onLongPress={!playlist.is_system ? () => openPlaylistEditor(playlist) : undefined}
              onPress={() => selectPlaylist(playlist)}
              style={({ pressed }) => [
                styles.card,
                selectedPlaylist?.id === playlist.id && styles.selectedCard,
                pressed && styles.pressed,
              ]}>
              <SongArtwork
                accessToken={session?.accessToken ?? null}
                colors={artworkPalettes[index % artworkPalettes.length]}
                size={72}
                song={playlistSummaryCoverSong(playlist, catalogSongById)}
              />
              <Text style={styles.cardTitle} numberOfLines={1}>
                {playlist.name}
              </Text>
              <Text style={styles.cardSubtitle} numberOfLines={2}>
                {playlist.description || (playlist.is_system ? "System playlist" : "Personal playlist")}
              </Text>
              <Text style={styles.cardCount}>{playlist.song_count} songs</Text>
            </Pressable>
          ))}
        </View>
      </Section>

      {selectedPlaylist ? (
        <Section>
          <Text style={styles.sectionTitle}>Songs In List</Text>
          <View style={styles.list}>
            {selectedPlaylist.songs.length ? (
              selectedPlaylist.songs.map((song, index) => {
                const displaySong = currentSong?.id === song.id ? currentSong : song;
                const tagPreview = songTagSummary(displaySong);
                return (
                  <SongListRow
                    accessToken={session?.accessToken ?? null}
                    action={
                      <SongActionMenu
                        accessToken={session?.accessToken ?? null}
                        canRemoveFromPlaylist
                        currentPlaylistId={selectedPlaylist.id}
                        isDownloaded={cacheStatus[displaySong.id] === "cached"}
                        isLiked={Boolean(displaySong.is_liked)}
                        onAddedToPlaylist={refreshAfterPlaylistChange}
                        onDownload={downloadSong}
                        onLikeChanged={updateSongLike}
                        onRemovedFromPlaylist={refreshAfterPlaylistChange}
                        onRemoveDownload={removeDownload}
                        removeFromPlaylistLabel={selectedIsSystem ? "Remove from Liked Music" : "Remove from This List"}
                        song={displaySong}
                      />
                    }
                    colors={artworkPalettes[index % artworkPalettes.length]}
                    isCached={cacheStatus[song.id] === "cached"}
                    key={song.id}
                    onPress={() => playFromPlaylist(song)}
                    isLiked={Boolean(displaySong.is_liked)}
                    song={displaySong}
                    statusActive={currentSong?.id === song.id}
                    statusText={playlistSongStatusText(song, cacheStatus[song.id], busySongId, currentSong?.id, isPlaying)}
                    subtitle={tagPreview}
                  />
                );
              })
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>Empty list</Text>
                <Text style={styles.emptyText}>{selectedIsSystem ? "Like songs from Library or Daily" : "Add songs below"}</Text>
              </View>
            )}
          </View>
        </Section>
      ) : null}

      {selectedPlaylist && !selectedIsSystem ? (
        <Section>
          <Text style={styles.sectionTitle}>Add Songs</Text>
          <View style={styles.list}>
            {availableSongs.map((song, index) => {
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
                      onAddedToPlaylist={refreshAfterPlaylistChange}
                      onDownload={downloadSong}
                      onLikeChanged={updateSongLike}
                      onRemoveDownload={removeDownload}
                      song={displaySong}
                    />
                  }
                  colors={artworkPalettes[(index + 2) % artworkPalettes.length]}
                  isCached={cacheStatus[song.id] === "cached"}
                  isLiked={Boolean(displaySong.is_liked)}
                  key={song.id}
                  song={displaySong}
                  statusActive={currentSong?.id === song.id}
                  statusText={playlistSongStatusText(song, cacheStatus[song.id], busySongId, currentSong?.id, isPlaying)}
                  subtitle={tagPreview}
                />
              );
            })}
            {loadingCatalogMore ? <Text style={styles.loadingMoreText}>Loading more songs</Text> : null}
          </View>
        </Section>
      ) : null}

      <Modal animationType="fade" transparent visible={Boolean(editingPlaylist)} onRequestClose={closePlaylistEditor}>
        <View style={styles.modalBackdrop}>
          <View style={styles.editorPanel}>
            <View style={styles.editorHeader}>
              <View style={styles.editorHeaderCopy}>
                <Text style={styles.editorLabel}>Edit Play List</Text>
                <Text style={styles.editorTitle} numberOfLines={1}>
                  {editingPlaylist?.name ?? "Play List"}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={closePlaylistEditor}
                style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
                <Text style={styles.closeIcon}>×</Text>
              </Pressable>
            </View>

            <TextInput
              autoCapitalize="words"
              editable={!savingEdit}
              onChangeText={setEditName}
              placeholder="Playlist name"
              placeholderTextColor={theme.colors.tertiaryText}
              style={styles.input}
              value={editName}
            />

            <View style={styles.coverEditor}>
              <Text style={styles.coverEditorTitle}>Cover</Text>
              {editingPlaylist?.songs.length ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.coverChoices}>
                    {editingPlaylist.songs.map((song, index) => {
                      const active = editCoverSongId === song.id;
                      return (
                        <Pressable
                          accessibilityRole="button"
                          key={song.id}
                          onPress={() => setEditCoverSongId(song.id)}
                          style={({ pressed }) => [
                            styles.coverChoice,
                            active && styles.coverChoiceActive,
                            pressed && styles.pressed,
                          ]}>
                          <SongArtwork
                            accessToken={session?.accessToken ?? null}
                            colors={artworkPalettes[index % artworkPalettes.length]}
                            size={62}
                            song={song}
                          />
                          <Text style={[styles.coverChoiceTitle, active && styles.coverChoiceTitleActive]} numberOfLines={1}>
                            {song.title}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </ScrollView>
              ) : (
                <Text style={styles.editorHint}>Add songs before choosing a cover.</Text>
              )}
            </View>

            {editError ? <Text style={styles.editorError}>{editError}</Text> : null}

            <View style={styles.editorActions}>
              <Pressable
                accessibilityRole="button"
                disabled={savingEdit}
                onPress={closePlaylistEditor}
                style={({ pressed }) => [styles.secondaryButton, savingEdit && styles.disabled, pressed && styles.pressed]}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!editName.trim() || savingEdit}
                onPress={submitPlaylistEdit}
                style={({ pressed }) => [
                  styles.saveButton,
                  (!editName.trim() || savingEdit) && styles.disabled,
                  pressed && styles.pressed,
                ]}>
                <Text style={styles.saveButtonText}>{savingEdit ? "Saving" : "Save"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </MusicPage>
  );
}

function playlistDetailCoverSong(playlist: PlaylistDetail): Song | null {
  if (playlist.cover_song_id) {
    return playlist.songs.find((song) => song.id === playlist.cover_song_id) ?? playlist.songs[0] ?? null;
  }
  return playlist.songs[0] ?? null;
}

function playlistSummaryCoverSong(playlist: PlaylistSummary, songsById: Map<string, Song>): Song | null {
  if (!playlist.cover_song_id) {
    return null;
  }
  return songsById.get(playlist.cover_song_id) ?? coverSongStub(playlist.cover_song_id);
}

function coverSongStub(songId: string): Song {
  return {
    id: songId,
    title: "",
    artist: "",
    album: "",
    duration_seconds: null,
    source: "playlist-cover",
    original_filename: "",
    file_size: 0,
    file_sha256: "",
    mime_type: "audio/mpeg",
    tags: [],
    audio_url: "",
    download_url: "",
    cover_url: `/v1/songs/${songId}/cover`,
    is_liked: false,
    liked_at: null,
    created_at: "",
    updated_at: "",
  };
}

function playlistSongStatusText(
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
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  eyebrow: {
    color: theme.colors.tint,
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 0,
  },
  title: {
    color: theme.colors.text,
    fontSize: 40,
    fontWeight: "900",
  },
  addButton: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  addIcon: {
    color: theme.colors.tint,
    fontSize: 25,
    fontWeight: "900",
    lineHeight: 27,
  },
  createPanel: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    flexDirection: "row",
    gap: 10,
    padding: 10,
  },
  input: {
    backgroundColor: "#F2F2F6",
    borderRadius: 8,
    color: theme.colors.text,
    flex: 1,
    fontSize: 15,
    fontWeight: "700",
    minHeight: 42,
    paddingHorizontal: 12,
  },
  createButton: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: 999,
    height: 42,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  createButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "900",
  },
  featured: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    flexDirection: "row",
    gap: 14,
    padding: 12,
  },
  featuredCopy: {
    flex: 1,
    minWidth: 0,
  },
  featuredLabel: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "900",
  },
  featuredTitle: {
    color: theme.colors.text,
    fontSize: 22,
    fontWeight: "900",
    marginTop: 3,
  },
  featuredMeta: {
    color: theme.colors.secondaryText,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  playButton: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: 999,
    minHeight: 42,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  playButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "900",
    lineHeight: 18,
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
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: "transparent",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    flexBasis: "48%",
    flexGrow: 1,
    gap: 6,
    minHeight: 184,
    padding: 10,
  },
  selectedCard: {
    borderColor: "rgba(255,45,85,0.32)",
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
  cardCount: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "800",
    marginTop: "auto",
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
    minHeight: 74,
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
    fontSize: 15,
    fontWeight: "900",
  },
  likeBadge: {
    color: theme.colors.tint,
    fontSize: 13,
    fontWeight: "900",
    lineHeight: 14,
  },
  rowMeta: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    marginTop: 3,
  },
  rowDetail: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    marginTop: 2,
  },
  activeText: {
    color: theme.colors.tint,
  },
  loadingMoreText: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "900",
    minHeight: 32,
    textAlign: "center",
    textAlignVertical: "center",
  },
  emptyState: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: 18,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "900",
  },
  emptyText: {
    color: theme.colors.secondaryText,
    fontSize: 13,
    marginTop: 3,
  },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(9,10,18,0.42)",
    flex: 1,
    justifyContent: "center",
    padding: 18,
  },
  editorPanel: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    gap: 14,
    maxHeight: "86%",
    padding: 16,
    width: "100%",
  },
  editorHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  editorHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  editorLabel: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "900",
  },
  editorTitle: {
    color: theme.colors.text,
    fontSize: 22,
    fontWeight: "900",
    marginTop: 2,
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: "#F2F2F6",
    borderRadius: 999,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  closeIcon: {
    color: theme.colors.secondaryText,
    fontSize: 24,
    fontWeight: "900",
    lineHeight: 26,
  },
  coverEditor: {
    gap: 8,
  },
  coverEditorTitle: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "900",
  },
  coverChoices: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 2,
  },
  coverChoice: {
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    gap: 6,
    padding: 7,
    width: 92,
  },
  coverChoiceActive: {
    borderColor: theme.colors.tint,
    backgroundColor: theme.colors.tintSoft,
  },
  coverChoiceTitle: {
    color: theme.colors.secondaryText,
    fontSize: 11,
    fontWeight: "800",
  },
  coverChoiceTitleActive: {
    color: theme.colors.tint,
  },
  editorHint: {
    color: theme.colors.secondaryText,
    fontSize: 13,
    fontWeight: "700",
  },
  editorError: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "800",
  },
  editorActions: {
    flexDirection: "row",
    gap: 10,
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "#F2F2F6",
    borderRadius: 999,
    flex: 1,
    minHeight: 42,
    justifyContent: "center",
  },
  secondaryButtonText: {
    color: theme.colors.secondaryText,
    fontSize: 13,
    fontWeight: "900",
  },
  saveButton: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: 999,
    flex: 1,
    minHeight: 42,
    justifyContent: "center",
  },
  saveButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "900",
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.75,
  },
});
