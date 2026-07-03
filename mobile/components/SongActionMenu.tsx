import { useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { usePlayer } from "@/components/PlayerProvider";
import { loadStoredSession } from "@/lib/auth";
import {
  addPlaylistSong,
  listPlaylists,
  loadCachedPlaylists,
  patchCachedPlaylistLike,
  removePlaylistSong,
  PlaylistSummary,
} from "@/lib/playlists";
import { setSongLiked, Song, songTagSummary } from "@/lib/songs";
import { theme } from "@/lib/theme";

type SongActionMenuProps = {
  accessToken: string | null;
  song: Song;
  isLiked: boolean;
  currentPlaylistId?: string | null;
  canRemoveFromPlaylist?: boolean;
  isDownloaded?: boolean;
  removeFromPlaylistLabel?: string;
  onAddedToPlaylist?: (playlistId: string) => Promise<void> | void;
  onDownload?: (song: Song) => Promise<void> | void;
  onLikeChanged?: (songId: string, isLiked: boolean, likedAt: string | null) => Promise<void> | void;
  onRemovedFromPlaylist?: () => Promise<void> | void;
  onRemoveDownload?: (song: Song) => Promise<void> | void;
};

export function SongActionMenu({
  accessToken,
  song,
  isLiked,
  currentPlaylistId = null,
  canRemoveFromPlaylist = false,
  isDownloaded = false,
  removeFromPlaylistLabel = "Remove from This List",
  onAddedToPlaylist,
  onDownload,
  onLikeChanged,
  onRemovedFromPlaylist,
  onRemoveDownload,
}: SongActionMenuProps) {
  const { playNext } = usePlayer();
  const tagPreview = songTagSummary(song);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"actions" | "playlists">("actions");
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [visible, setVisible] = useState(false);

  function close() {
    if (busy) {
      return;
    }
    setVisible(false);
    setMode("actions");
    setError(null);
  }

  async function toggleLike() {
    if (!accessToken || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await setSongLiked(accessToken, song.id, !isLiked);
      const session = await loadStoredSession();
      await patchCachedPlaylistLike(session?.user.id, song.id, result.is_liked, result.liked_at);
      await onLikeChanged?.(song.id, result.is_liked, result.liked_at);
      closeAfterAction();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not update like.");
    } finally {
      setBusy(false);
    }
  }

  function queuePlayNext() {
    playNext(song);
    closeAfterAction();
  }

  async function downloadSong() {
    if (!accessToken || busy || isDownloaded || !onDownload) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onDownload(song);
      closeAfterAction();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not download song.");
    } finally {
      setBusy(false);
    }
  }

  function confirmRemoveDownload() {
    if (busy || !isDownloaded || !onRemoveDownload) {
      return;
    }
    Alert.alert(
      "Remove download?",
      "This removes the local audio file from this device. The song will stay in your library.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void removeDownload();
          },
        },
      ],
    );
  }

  async function removeDownload() {
    if (busy || !isDownloaded || !onRemoveDownload) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRemoveDownload(song);
      closeAfterAction();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not remove download.");
    } finally {
      setBusy(false);
    }
  }

  async function showPlaylists() {
    if (!accessToken || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await loadStoredSession();
      const cached = await loadCachedPlaylists(session?.user.id);
      if (cached) {
        setPlaylists(cached.playlists.filter((playlist) => !playlist.is_system && playlist.id !== currentPlaylistId));
        setMode("playlists");
      }
      const response = await listPlaylists(accessToken);
      setPlaylists(response.playlists.filter((playlist) => !playlist.is_system && playlist.id !== currentPlaylistId));
      setMode("playlists");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not load lists.");
    } finally {
      setBusy(false);
    }
  }

  async function addToPlaylist(playlist: PlaylistSummary) {
    if (!accessToken || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addPlaylistSong(accessToken, playlist.id, song.id);
      await onAddedToPlaylist?.(playlist.id);
      closeAfterAction();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not add song to list.");
    } finally {
      setBusy(false);
    }
  }

  async function removeFromPlaylist() {
    if (!accessToken || !currentPlaylistId || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await removePlaylistSong(accessToken, currentPlaylistId, song.id);
      await onRemovedFromPlaylist?.();
      closeAfterAction();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not remove song.");
    } finally {
      setBusy(false);
    }
  }

  function closeAfterAction() {
    setVisible(false);
    setMode("actions");
    setError(null);
  }

  return (
    <>
      <Pressable
        accessibilityLabel={`More actions for ${song.title}`}
        accessibilityRole="button"
        onPress={(event) => {
          event.stopPropagation();
          setVisible(true);
        }}
        style={({ pressed }) => [styles.menuButton, pressed && styles.pressed]}>
        <Text style={styles.menuIcon}>...</Text>
      </Pressable>

      <Modal animationType="fade" transparent visible={visible} onRequestClose={close}>
        <View style={styles.modalRoot}>
          <Pressable accessibilityLabel="Close song actions" style={styles.backdrop} onPress={close} />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {song.title}
            </Text>
            {tagPreview ? (
              <Text style={styles.sheetMeta} numberOfLines={1}>
                {tagPreview}
              </Text>
            ) : null}

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            {mode === "actions" ? (
              <View style={styles.actionList}>
                <Pressable
                  accessibilityRole="button"
                  disabled={!accessToken || busy}
                  onPress={toggleLike}
                  style={({ pressed }) => [styles.actionRow, pressed && styles.pressed, (!accessToken || busy) && styles.disabled]}>
                  <Text style={[styles.actionIcon, isLiked && styles.likeActive]}>{isLiked ? "♥" : "♡"}</Text>
                  <Text style={styles.actionText}>{isLiked ? "Unlike" : "Like"}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={queuePlayNext}
                  style={({ pressed }) => [styles.actionRow, pressed && styles.pressed, busy && styles.disabled]}>
                  <Text style={styles.actionIcon}>▶</Text>
                  <Text style={styles.actionText}>Play Next</Text>
                </Pressable>
                {onDownload ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={!accessToken || busy || (isDownloaded ? !onRemoveDownload : false)}
                    onPress={isDownloaded ? confirmRemoveDownload : downloadSong}
                    style={({ pressed }) => [
                      styles.actionRow,
                      pressed && styles.pressed,
                      (!accessToken || busy || (isDownloaded ? !onRemoveDownload : false)) && styles.disabled,
                    ]}>
                    <Text style={[styles.actionIcon, isDownloaded && styles.removeIcon]}>{isDownloaded ? "×" : "↓"}</Text>
                    <Text style={[styles.actionText, isDownloaded && styles.removeText]}>
                      {isDownloaded ? "Remove Download" : "Download"}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  disabled={!accessToken || busy}
                  onPress={showPlaylists}
                  style={({ pressed }) => [styles.actionRow, pressed && styles.pressed, (!accessToken || busy) && styles.disabled]}>
                  <Text style={styles.actionIcon}>＋</Text>
                  <Text style={styles.actionText}>Add to List</Text>
                </Pressable>
                {canRemoveFromPlaylist && currentPlaylistId ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={!accessToken || busy}
                    onPress={removeFromPlaylist}
                    style={({ pressed }) => [styles.actionRow, pressed && styles.pressed, (!accessToken || busy) && styles.disabled]}>
                    <Text style={styles.actionIcon}>×</Text>
                    <Text style={styles.actionText}>{removeFromPlaylistLabel}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              <View style={styles.actionList}>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => setMode("actions")}
                  style={({ pressed }) => [styles.actionRow, pressed && styles.pressed, busy && styles.disabled]}>
                  <Text style={styles.actionIcon}>‹</Text>
                  <Text style={styles.actionText}>Back</Text>
                </Pressable>
                {playlists.length ? (
                  playlists.map((playlist) => (
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      key={playlist.id}
                      onPress={() => addToPlaylist(playlist)}
                      style={({ pressed }) => [styles.playlistRow, pressed && styles.pressed, busy && styles.disabled]}>
                      <View style={styles.playlistCopy}>
                        <Text style={styles.playlistTitle} numberOfLines={1}>
                          {playlist.name}
                        </Text>
                        <Text style={styles.playlistMeta}>{playlist.song_count} songs</Text>
                      </View>
                    </Pressable>
                  ))
                ) : (
                  <Text style={styles.emptyText}>No personal lists yet.</Text>
                )}
              </View>
            )}

            {busy ? (
              <View style={styles.busyRow}>
                <ActivityIndicator color={theme.colors.tint} size="small" />
              </View>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  menuButton: {
    alignItems: "center",
    backgroundColor: "#F1F1F4",
    borderRadius: 999,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  menuIcon: {
    color: theme.colors.secondaryText,
    fontSize: 17,
    fontWeight: "900",
    lineHeight: 18,
  },
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    backgroundColor: "rgba(0,0,0,0.18)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  sheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 28,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  handle: {
    alignSelf: "center",
    backgroundColor: "#D6D6DC",
    borderRadius: 999,
    height: 4,
    marginBottom: 14,
    width: 44,
  },
  sheetTitle: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "900",
  },
  sheetMeta: {
    color: theme.colors.secondaryText,
    fontSize: 13,
    fontWeight: "700",
    marginTop: 3,
  },
  errorText: {
    color: theme.colors.tint,
    fontSize: 13,
    fontWeight: "800",
    marginTop: 10,
  },
  actionList: {
    gap: 8,
    marginTop: 16,
  },
  actionRow: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: 8,
    flexDirection: "row",
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 14,
  },
  actionIcon: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "900",
    textAlign: "center",
    width: 24,
  },
  likeActive: {
    color: theme.colors.tint,
  },
  removeIcon: {
    color: theme.colors.tint,
  },
  removeText: {
    color: theme.colors.tint,
  },
  actionText: {
    color: theme.colors.text,
    flex: 1,
    fontSize: 15,
    fontWeight: "900",
  },
  playlistRow: {
    backgroundColor: theme.colors.surface,
    borderRadius: 8,
    minHeight: 56,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  playlistCopy: {
    minWidth: 0,
  },
  playlistTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "900",
  },
  playlistMeta: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 2,
  },
  emptyText: {
    color: theme.colors.secondaryText,
    fontSize: 14,
    fontWeight: "800",
    paddingVertical: 18,
    textAlign: "center",
  },
  busyRow: {
    alignItems: "center",
    height: 28,
    justifyContent: "center",
    marginTop: 8,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.72,
  },
});
