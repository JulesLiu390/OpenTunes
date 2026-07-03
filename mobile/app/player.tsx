import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  GestureResponderEvent,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
  type LayoutChangeEvent,
} from "react-native";
import { VolumeManager } from "react-native-volume-manager";

import { useAuth } from "@/components/AuthProvider";
import { PlayMode, usePlayer } from "@/components/PlayerProvider";
import { SongArtwork } from "@/components/SongArtwork";
import { SongListRow } from "@/components/SongListRow";
import { currentTrack } from "@/lib/demo";
import { formatDuration, getSong, setSongLiked, songTagSummary, type Song } from "@/lib/songs";
import { getMusicTags, setMusicTags } from "@/lib/taste";
import { artworkPalettes, theme } from "@/lib/theme";

type TagAction = {
  tag: string;
  liked: boolean;
};

export default function PlayerScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const {
    currentSong,
    currentTime,
    duration,
    isPlaying,
    nextSong,
    playMode,
    playSong,
    previousSong,
    queue,
    cyclePlayMode,
    seekTo,
    togglePlayPause,
    updateCurrentSongLike,
  } = usePlayer();
  const [likeBusy, setLikeBusy] = useState(false);
  const [queueMounted, setQueueMounted] = useState(false);
  const [queueVisible, setQueueVisible] = useState(false);
  const [tagsVisible, setTagsVisible] = useState(false);
  const [tagsSong, setTagsSong] = useState<Song | null>(null);
  const [tasteTags, setTasteTags] = useState<string[]>([]);
  const [tasteTagsLoading, setTasteTagsLoading] = useState(false);
  const [tasteTagsReady, setTasteTagsReady] = useState(false);
  const [tagAction, setTagAction] = useState<TagAction | null>(null);
  const [tagActionBusy, setTagActionBusy] = useState(false);
  const [systemVolume, setSystemVolume] = useState(1);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const queueAnimation = useRef(new Animated.Value(0)).current;
  const progressTrackRef = useRef<View | null>(null);
  const progressTrackPageXRef = useRef(0);
  const pendingSeekTimeRef = useRef(0);
  const params = useLocalSearchParams<{ title?: string | string[]; subtitle?: string | string[] }>();
  const title = Array.isArray(params.title) ? params.title[0] : params.title;
  const subtitle = Array.isArray(params.subtitle) ? params.subtitle[0] : params.subtitle;
  const displayTitle = currentSong?.title ?? title ?? currentTrack.name;
  const displaySubtitle = currentSong ? songTagSummary(currentSong) : (subtitle ?? "");
  const displayDuration = duration || currentSong?.duration_seconds || 0;
  const displayedCurrentTime = scrubTime ?? currentTime;
  const progress = displayDuration > 0 ? Math.min(100, Math.max(0, (displayedCurrentTime / displayDuration) * 100)) : 0;
  const knobPosition = `${Math.min(96, progress)}%` as DimensionValue;
  const canSeek = Boolean(currentSong && displayDuration > 0);
  const volumeLevel = clampVolume(systemVolume);
  const volumeWidth = `${Math.round(volumeLevel * 100)}%` as DimensionValue;
  const isLiked = Boolean(currentSong?.is_liked);
  const tagDisplaySong = tagsSong?.id === currentSong?.id ? tagsSong : currentSong;
  const likedTagKeys = useMemo(() => new Set(tasteTags.map(normalizeTagKey)), [tasteTags]);
  const queueMotion = useMemo(
    () => ({
      backdropOpacity: queueAnimation.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 1],
      }),
      sheetTranslateY: queueAnimation.interpolate({
        inputRange: [0, 1],
        outputRange: [360, 0],
      }),
    }),
    [queueAnimation],
  );
  const progressResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: () => canSeek,
        onMoveShouldSetPanResponderCapture: () => canSeek,
        onStartShouldSetPanResponder: () => canSeek,
        onStartShouldSetPanResponderCapture: () => canSeek,
        onPanResponderGrant: (event) => {
          if (!canSeek) {
            return;
          }
          progressTrackRef.current?.measure((_x, _y, width, _height, pageX) => {
            progressTrackPageXRef.current = pageX;
            setTrackWidth(width);
            updateScrubTime(event.nativeEvent.locationX, width);
          });
        },
        onPanResponderMove: (_event, gestureState) => {
          if (!canSeek) {
            return;
          }
          const width = trackWidth || 1;
          updateScrubTime(gestureState.moveX - progressTrackPageXRef.current, width);
        },
        onPanResponderRelease: (_event, gestureState) => {
          if (!canSeek) {
            setScrubTime(null);
            return;
          }
          const width = trackWidth || 1;
          const nextTime = pendingSeekTimeRef.current || timeForTrackOffset(gestureState.moveX - progressTrackPageXRef.current, width, displayDuration);
          setScrubTime(nextTime);
          seekTo(nextTime)
            .catch(() => {
              // Keep the visual scrub stable even if one platform rejects a seek.
            })
            .finally(() => {
              pendingSeekTimeRef.current = 0;
              setScrubTime(null);
            });
        },
        onPanResponderTerminate: () => {
          pendingSeekTimeRef.current = 0;
          setScrubTime(null);
        },
      }),
    [canSeek, displayDuration, seekTo, trackWidth],
  );

  useEffect(() => {
    if (Platform.OS === "web") {
      return;
    }

    let mounted = true;
    VolumeManager.getVolume()
      .then(({ volume }) => {
        if (mounted) {
          setSystemVolume(clampVolume(volume));
        }
      })
      .catch(() => {
        // System volume is display-only; playback should continue if native volume is unavailable.
      });

    const subscription = VolumeManager.addVolumeListener(({ volume }) => {
      setSystemVolume(clampVolume(volume));
    });

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!queueMounted) {
      return;
    }

    queueAnimation.stopAnimation();
    Animated.timing(queueAnimation, {
      duration: queueVisible ? 220 : 170,
      easing: queueVisible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      toValue: queueVisible ? 1 : 0,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !queueVisible) {
        setQueueMounted(false);
      }
    });
  }, [queueAnimation, queueMounted, queueVisible]);

  function openQueue() {
    queueAnimation.stopAnimation();
    queueAnimation.setValue(0);
    setQueueMounted(true);
    setQueueVisible(true);
  }

  function closeQueue() {
    setQueueVisible(false);
  }

  async function openTags() {
    if (!currentSong) {
      return;
    }
    const song = currentSong;
    setTagsSong(song);
    setTagsVisible(true);
    if (!session) {
      return;
    }
    setTasteTagsReady(false);
    setTasteTagsLoading(true);
    try {
      const [freshSongResult, tasteTagsResult] = await Promise.allSettled([
        getSong(session.accessToken, song.id),
        getMusicTags(session.accessToken),
      ]);
      if (freshSongResult.status === "fulfilled") {
        const freshSong = freshSongResult.value;
        setTagsSong((current) => (current?.id === song.id ? freshSong : current));
      }
      if (tasteTagsResult.status === "fulfilled") {
        setTasteTags(tasteTagsResult.value.tags);
        setTasteTagsReady(true);
      }
    } finally {
      setTasteTagsLoading(false);
    }
  }

  function requestTagAction(tag: string) {
    if (!session || tagActionBusy || tasteTagsLoading || !tasteTagsReady) {
      return;
    }
    setTagAction({ tag, liked: likedTagKeys.has(normalizeTagKey(tag)) });
  }

  async function submitTagAction() {
    if (!session || !tagAction || tagActionBusy) {
      return;
    }
    setTagActionBusy(true);
    const actionKey = normalizeTagKey(tagAction.tag);
    const nextTags = tagAction.liked
      ? tasteTags.filter((tag) => normalizeTagKey(tag) !== actionKey)
      : [...tasteTags.filter((tag) => normalizeTagKey(tag) !== actionKey), tagAction.tag];
    try {
      const response = await setMusicTags(session.accessToken, nextTags);
      setTasteTags(response.tags);
      setTasteTagsReady(true);
      setTagAction(null);
    } finally {
      setTagActionBusy(false);
    }
  }

  async function toggleLike() {
    if (!session || !currentSong || likeBusy) {
      return;
    }
    setLikeBusy(true);
    try {
      const result = await setSongLiked(session.accessToken, currentSong.id, !isLiked);
      updateCurrentSongLike(currentSong.id, result.is_liked, result.liked_at);
    } finally {
      setLikeBusy(false);
    }
  }

  async function playQueuedSong(songId: string) {
    const song = queue.find((candidate) => candidate.id === songId);
    if (!song) {
      return;
    }
    await playSong(song, queue, { source: "adHoc" });
    closeQueue();
  }

  function handleProgressLayout(event: LayoutChangeEvent) {
    setTrackWidth(event.nativeEvent.layout.width);
  }

  function handleProgressPress(event: GestureResponderEvent) {
    if (!canSeek) {
      return;
    }
    const nextTime = timeForTrackOffset(event.nativeEvent.locationX, trackWidth || 1, displayDuration);
    pendingSeekTimeRef.current = nextTime;
    setScrubTime(nextTime);
    seekTo(nextTime)
      .catch(() => {
        // Seeking is best-effort across native and web audio backends.
      })
      .finally(() => {
        pendingSeekTimeRef.current = 0;
        setScrubTime(null);
      });
  }

  function updateScrubTime(offsetX: number, width: number) {
    const nextTime = timeForTrackOffset(offsetX, width, displayDuration);
    pendingSeekTimeRef.current = nextTime;
    setScrubTime(nextTime);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]} onPress={() => router.back()}>
            <Text style={styles.headerIcon}>⌄</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Now Playing</Text>
          <Pressable style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <Text style={styles.headerIcon}>⋯</Text>
          </Pressable>
        </View>

        <Pressable
          accessibilityLabel="Show song tags"
          accessibilityRole="button"
          disabled={!currentSong}
          onPress={openTags}
          style={({ pressed }) => [styles.artWrap, pressed && styles.pressed, !currentSong && styles.disabledButton]}>
          <SongArtwork accessToken={session?.accessToken ?? null} colors={artworkPalettes[0]} size={312} song={currentSong} />
        </Pressable>

        <View style={styles.trackBlock}>
          <View style={styles.titleRow}>
            <View style={styles.trackCopy}>
              <Text style={styles.songTitle} numberOfLines={1}>
                {displayTitle}
              </Text>
              {displaySubtitle ? (
                <Text style={styles.artist} numberOfLines={1}>
                  {displaySubtitle}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityLabel={isLiked ? "Unlike song" : "Like song"}
              accessibilityRole="button"
              disabled={!currentSong || likeBusy}
              onPress={toggleLike}
              style={({ pressed }) => [styles.favorite, pressed && styles.pressed, (!currentSong || likeBusy) && styles.disabledButton]}>
              <Text style={[styles.favoriteIcon, isLiked && styles.favoriteIconActive]}>{isLiked ? "♥" : "♡"}</Text>
            </Pressable>
          </View>

          <View style={styles.progressBlock}>
            <Pressable
              accessibilityLabel="Seek playback position"
              accessibilityRole="adjustable"
              disabled={!canSeek}
              hitSlop={12}
              onPress={handleProgressPress}
              style={[styles.trackLineTouch, !canSeek && styles.disabledButton]}>
              <View
                ref={progressTrackRef}
                onLayout={handleProgressLayout}
                style={styles.trackLine}
                {...progressResponder.panHandlers}>
                <View style={[styles.playedLine, { width: `${progress}%` }]} />
                <View style={[styles.knob, { left: knobPosition }]} />
              </View>
            </Pressable>
            <View style={styles.timeRow}>
              <Text style={styles.time}>{formatDuration(Math.floor(displayedCurrentTime))}</Text>
              <Text style={styles.time}>
                {displayDuration > 0 ? formatDuration(Math.floor(displayDuration)) : currentTrack.duration}
              </Text>
            </View>
          </View>

          <View style={styles.controls}>
            <Pressable
              accessibilityLabel="Previous song"
              accessibilityRole="button"
              disabled={!currentSong}
              onPress={() => {
                previousSong();
              }}
              style={({ pressed }) => [styles.controlButton, pressed && styles.pressed, !currentSong && styles.disabledButton]}>
              <Text style={styles.controlIcon}>⏮</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={isPlaying ? "Pause song" : "Play song"}
              accessibilityRole="button"
              disabled={!currentSong}
              onPress={togglePlayPause}
              style={({ pressed }) => [styles.mainButton, pressed && styles.pressed, !currentSong && styles.disabledButton]}>
              <Text style={[styles.mainIcon, isPlaying && styles.pauseMainIcon]}>{isPlaying ? "Ⅱ" : "▶"}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Next song"
              accessibilityRole="button"
              disabled={!currentSong}
              onPress={() => {
                nextSong();
              }}
              style={({ pressed }) => [styles.controlButton, pressed && styles.pressed, !currentSong && styles.disabledButton]}>
              <Text style={styles.controlIcon}>⏭</Text>
            </Pressable>
          </View>

          <View style={styles.volumeRow}>
            <Text style={styles.volumeIcon}>♪</Text>
            <View style={styles.volumeTrack}>
              <View style={[styles.volumeFill, { width: volumeWidth }]} />
            </View>
            <Text style={styles.volumeValue}>{Math.round(volumeLevel * 100)}%</Text>
            <Text style={styles.volumeIcon}>♫</Text>
          </View>
        </View>

        <View style={styles.bottomActions}>
          <Pressable
            accessibilityLabel={playModeLabel(playMode)}
            accessibilityRole="button"
            onPress={cyclePlayMode}
            style={({ pressed }) => [styles.actionButton, styles.activeActionButton, pressed && styles.pressed]}>
            <MaterialCommunityIcons name={playModeIcon(playMode)} size={24} color={theme.colors.tint} />
          </Pressable>
          <Pressable
            accessibilityLabel="Show queue list"
            accessibilityRole="button"
            onPress={openQueue}
            style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}>
            <Text style={styles.actionIcon}>≡</Text>
          </Pressable>
        </View>

        <Modal animationType="none" transparent visible={queueMounted} onRequestClose={closeQueue}>
          <View style={styles.queueModal}>
            <Animated.View style={[styles.queueBackdrop, { opacity: queueMotion.backdropOpacity }]} />
            <Pressable accessibilityLabel="Close queue" style={styles.queueDismissArea} onPress={closeQueue} />
            <Animated.View style={[styles.queueSheet, { transform: [{ translateY: queueMotion.sheetTranslateY }] }]}>
              <View style={styles.queueHeader}>
                <View>
                  <Text style={styles.queueLabel}>Queue</Text>
                  <Text style={styles.queueTitle}>{queue.length ? `${queue.length} songs` : "No songs queued"}</Text>
                </View>
                <Pressable
                  accessibilityLabel="Close queue"
                  accessibilityRole="button"
                  onPress={closeQueue}
                  style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
                  <Text style={styles.closeIcon}>×</Text>
                </Pressable>
              </View>
              <ScrollView contentContainerStyle={styles.queueList} showsVerticalScrollIndicator={false}>
                {queue.length === 0 ? (
                  <Text style={styles.emptyQueue}>Play a song from Daily, Library, or Play Lists to build a queue.</Text>
                ) : (
                  queue.map((song, index) => {
                    const active = currentSong?.id === song.id;
                    const tagPreview = songTagSummary(song);
                    return (
                      <SongListRow
                        accessToken={session?.accessToken ?? null}
                        colors={artworkPalettes[index % artworkPalettes.length]}
                        key={song.id}
                        onPress={() => {
                          playQueuedSong(song.id);
                        }}
                        song={song}
                        statusActive={active}
                        statusText={formatDuration(song.duration_seconds)}
                        subtitle={tagPreview}
                      />
                    );
                  })
                )}
              </ScrollView>
            </Animated.View>
          </View>
        </Modal>

        <Modal animationType="fade" transparent visible={tagsVisible} onRequestClose={() => setTagsVisible(false)}>
          <View style={styles.tagsModal}>
            <Pressable accessibilityLabel="Close song tags" style={styles.tagsBackdrop} onPress={() => setTagsVisible(false)} />
            <View style={styles.tagsSheet}>
              <View style={styles.tagsHeader}>
                <View style={styles.tagsHeaderCopy}>
                  <Text style={styles.tagsLabel}>Tags</Text>
                  <Text style={styles.tagsTitle} numberOfLines={1}>
                    {tagDisplaySong?.title ?? "Current Song"}
                  </Text>
                </View>
                {tasteTagsLoading ? <ActivityIndicator color={theme.colors.tint} size="small" /> : null}
                <Pressable
                  accessibilityLabel="Close song tags"
                  accessibilityRole="button"
                  onPress={() => setTagsVisible(false)}
                  style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
                  <Text style={styles.closeIcon}>×</Text>
                </Pressable>
              </View>
              <ScrollView contentContainerStyle={styles.tagsList} showsVerticalScrollIndicator={false}>
                {tagDisplaySong?.tags.length ? (
                  tagDisplaySong.tags.map((tag) => {
                    const liked = likedTagKeys.has(normalizeTagKey(tag));
                    return (
                      <Pressable
                        accessibilityLabel={liked ? `Remove taste tag ${tag}` : `Add taste tag ${tag}`}
                        accessibilityRole="button"
                        disabled={!session || tagActionBusy || tasteTagsLoading || !tasteTagsReady}
                        key={tag}
                        onPress={() => requestTagAction(tag)}
                        style={({ pressed }) => [
                          styles.tagPill,
                          liked && styles.tagPillLiked,
                          pressed && styles.pressed,
                          (!session || tagActionBusy || tasteTagsLoading || !tasteTagsReady) && styles.disabledButton,
                        ]}>
                        <Text style={[styles.tagText, liked && styles.tagTextLiked]}>{tag}</Text>
                        {liked ? <Text style={styles.tagLikedMark}>♥</Text> : null}
                      </Pressable>
                    );
                  })
                ) : (
                  <Text style={styles.emptyQueue}>No tags for this song.</Text>
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>

        <Modal
          animationType="fade"
          transparent
          visible={Boolean(tagAction)}
          onRequestClose={() => {
            if (!tagActionBusy) {
              setTagAction(null);
            }
          }}>
          <View style={styles.tagConfirmModal}>
            <Pressable
              accessibilityLabel="Cancel tag action"
              disabled={tagActionBusy}
              onPress={() => setTagAction(null)}
              style={styles.tagConfirmBackdrop}
            />
            <View style={styles.tagConfirmPanel}>
              <Text style={styles.tagConfirmTitle}>{tagAction?.liked ? "Remove tag?" : "Like tag?"}</Text>
              <Text style={styles.tagConfirmText}>
                {tagAction?.liked
                  ? `Remove "${tagAction.tag}" from your taste tags?`
                  : `Add "${tagAction?.tag ?? ""}" to your taste tags?`}
              </Text>
              <View style={styles.tagConfirmActions}>
                <Pressable
                  accessibilityRole="button"
                  disabled={tagActionBusy}
                  onPress={() => setTagAction(null)}
                  style={({ pressed }) => [styles.tagCancelButton, pressed && styles.pressed, tagActionBusy && styles.disabledButton]}>
                  <Text style={styles.tagCancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={!tagAction || tagActionBusy}
                  onPress={submitTagAction}
                  style={({ pressed }) => [styles.tagConfirmButton, pressed && styles.pressed, (!tagAction || tagActionBusy) && styles.disabledButton]}>
                  {tagActionBusy ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.tagConfirmButtonText}>{tagAction?.liked ? "Remove" : "Like"}</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  screen: {
    flex: 1,
    justifyContent: "space-between",
    paddingBottom: 22,
    paddingHorizontal: 24,
    paddingTop: 30,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  headerIcon: {
    color: theme.colors.text,
    fontSize: 26,
    fontWeight: "900",
    lineHeight: 28,
  },
  headerTitle: {
    color: theme.colors.secondaryText,
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  artWrap: {
    alignItems: "center",
    paddingTop: 12,
  },
  trackBlock: {
    gap: 28,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 16,
  },
  trackCopy: {
    flex: 1,
    minWidth: 0,
  },
  songTitle: {
    color: theme.colors.text,
    fontSize: 28,
    fontWeight: "900",
  },
  artist: {
    color: theme.colors.tint,
    fontSize: 18,
    fontWeight: "800",
    marginTop: 4,
  },
  favorite: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  favoriteIcon: {
    color: theme.colors.tint,
    fontSize: 28,
    fontWeight: "800",
    lineHeight: 30,
  },
  favoriteIconActive: {
    color: theme.colors.tint,
  },
  progressBlock: {
    gap: 8,
  },
  trackLineTouch: {
    justifyContent: "center",
    minHeight: 34,
  },
  trackLine: {
    backgroundColor: "#D9D9DF",
    borderRadius: 999,
    height: 7,
    justifyContent: "center",
  },
  playedLine: {
    backgroundColor: theme.colors.tint,
    borderRadius: 999,
    height: 7,
    width: "32%",
  },
  knob: {
    backgroundColor: theme.colors.tint,
    borderColor: theme.colors.surface,
    borderRadius: 999,
    borderWidth: 3,
    height: 18,
    left: "31%",
    position: "absolute",
    width: 18,
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  time: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "700",
  },
  controls: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 26,
  },
  controlButton: {
    alignItems: "center",
    height: 58,
    justifyContent: "center",
    width: 58,
  },
  controlIcon: {
    color: theme.colors.text,
    fontSize: 28,
    fontWeight: "900",
    lineHeight: 30,
  },
  mainButton: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: 999,
    height: 76,
    justifyContent: "center",
    width: 76,
  },
  mainIcon: {
    color: "#FFFFFF",
    fontSize: 30,
    fontWeight: "900",
    lineHeight: 32,
    marginLeft: 3,
  },
  pauseMainIcon: {
    fontSize: 26,
    lineHeight: 28,
    marginLeft: 0,
  },
  disabledButton: {
    opacity: 0.45,
  },
  volumeRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  volumeTrack: {
    backgroundColor: "#D9D9DF",
    borderRadius: 999,
    flex: 1,
    height: 6,
  },
  volumeIcon: {
    color: theme.colors.tertiaryText,
    fontSize: 16,
    fontWeight: "900",
    lineHeight: 18,
    width: 18,
  },
  volumeValue: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "800",
    textAlign: "right",
    width: 34,
  },
  volumeFill: {
    backgroundColor: theme.colors.secondaryText,
    borderRadius: 999,
    height: 6,
  },
  bottomActions: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-around",
  },
  actionButton: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    height: 48,
    justifyContent: "center",
    width: 72,
  },
  actionIcon: {
    color: theme.colors.secondaryText,
    fontSize: 24,
    fontWeight: "900",
    lineHeight: 26,
  },
  activeActionButton: {
    borderColor: "rgba(255,45,85,0.32)",
  },
  activeActionIcon: {
    color: theme.colors.tint,
  },
  pressed: {
    opacity: 0.72,
  },
  queueModal: {
    flex: 1,
    justifyContent: "flex-end",
  },
  queueBackdrop: {
    backgroundColor: "rgba(0,0,0,0.18)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  queueDismissArea: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  queueSheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: "72%",
    paddingBottom: 28,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  queueHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  queueLabel: {
    color: theme.colors.tint,
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  queueTitle: {
    color: theme.colors.text,
    fontSize: 22,
    fontWeight: "900",
    marginTop: 2,
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  closeIcon: {
    color: theme.colors.text,
    fontSize: 28,
    fontWeight: "900",
    lineHeight: 30,
  },
  queueList: {
    gap: 8,
    paddingBottom: 16,
  },
  emptyQueue: {
    color: theme.colors.secondaryText,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 22,
    paddingVertical: 28,
    textAlign: "center",
  },
  queueRow: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    minHeight: 62,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  queueRowActive: {
    borderColor: "rgba(255,45,85,0.38)",
  },
  queueIndex: {
    color: theme.colors.tertiaryText,
    fontSize: 13,
    fontWeight: "900",
    textAlign: "center",
    width: 26,
  },
  queueIndexActive: {
    color: theme.colors.tint,
  },
  queueCopy: {
    flex: 1,
    minWidth: 0,
  },
  queueSongTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "900",
  },
  queueSongTitleActive: {
    color: theme.colors.tint,
  },
  queueSongMeta: {
    color: theme.colors.secondaryText,
    fontSize: 13,
    fontWeight: "700",
    marginTop: 2,
  },
  queueDuration: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "800",
  },
  tagsModal: {
    flex: 1,
    justifyContent: "flex-end",
  },
  tagsBackdrop: {
    backgroundColor: "rgba(0,0,0,0.18)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  tagsSheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: "70%",
    paddingBottom: 28,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  tagsHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    marginBottom: 12,
  },
  tagsHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  tagsLabel: {
    color: theme.colors.tint,
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  tagsTitle: {
    color: theme.colors.text,
    fontSize: 22,
    fontWeight: "900",
    marginTop: 2,
  },
  tagsList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingBottom: 16,
  },
  tagPill: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  tagPillLiked: {
    backgroundColor: theme.colors.tintSoft,
    borderColor: theme.colors.tint,
  },
  tagText: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  tagTextLiked: {
    color: theme.colors.tint,
  },
  tagLikedMark: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "900",
    lineHeight: 14,
  },
  tagConfirmModal: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  tagConfirmBackdrop: {
    backgroundColor: "rgba(0,0,0,0.22)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  tagConfirmPanel: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    gap: 12,
    maxWidth: 360,
    padding: 18,
    width: "100%",
  },
  tagConfirmTitle: {
    color: theme.colors.text,
    fontSize: 21,
    fontWeight: "900",
  },
  tagConfirmText: {
    color: theme.colors.secondaryText,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
  },
  tagConfirmActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  tagCancelButton: {
    alignItems: "center",
    backgroundColor: theme.colors.background,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minHeight: 42,
    justifyContent: "center",
  },
  tagCancelText: {
    color: theme.colors.secondaryText,
    fontSize: 14,
    fontWeight: "900",
  },
  tagConfirmButton: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: theme.radius.pill,
    flex: 1,
    minHeight: 42,
    justifyContent: "center",
  },
  tagConfirmButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "900",
  },
});

type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

function playModeIcon(mode: PlayMode): IconName {
  if (mode === "shuffle") {
    return "shuffle";
  }
  if (mode === "one") {
    return "repeat-once";
  }
  if (mode === "list") {
    return "playlist-play";
  }
  return "repeat";
}

function playModeLabel(mode: PlayMode): string {
  if (mode === "shuffle") {
    return "Shuffle";
  }
  if (mode === "one") {
    return "Repeat one";
  }
  if (mode === "list") {
    return "Play list once";
  }
  return "Repeat all";
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}

function timeForTrackOffset(offsetX: number, width: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(width) || width <= 0) {
    return 0;
  }
  const ratio = Math.max(0, Math.min(1, offsetX / width));
  return ratio * duration;
}

function normalizeTagKey(tag: string): string {
  return tag.trim().toLowerCase();
}
