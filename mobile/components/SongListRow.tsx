import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { SongArtwork } from "@/components/SongArtwork";
import { Song } from "@/lib/songs";
import { theme } from "@/lib/theme";

type SongListRowProps = {
  accessToken: string | null;
  action?: ReactNode;
  colors: string[];
  isCached?: boolean;
  isLiked?: boolean;
  onPress?: () => void;
  song: Song;
  statusActive?: boolean;
  statusText?: string | null;
  subtitle?: string | null;
};

export function SongListRow({
  accessToken,
  action,
  colors,
  isCached = false,
  isLiked,
  onPress,
  song,
  statusActive = false,
  statusText,
  subtitle,
}: SongListRowProps) {
  const content = (
    <>
      <SongArtwork accessToken={accessToken} colors={colors} size={50} song={song} />
      <View style={styles.copy}>
        <View style={styles.titleLine}>
          <Text style={styles.title} numberOfLines={1}>
            {song.title}
          </Text>
          {isLiked ? <Text style={styles.likeBadge}>♥</Text> : null}
        </View>
        {subtitle ? (
          <Text style={styles.meta} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {statusText ? (
        <View style={styles.trailing}>
          {isCached ? <Text style={styles.cachedBadge}>✓</Text> : null}
          <Text style={[styles.status, statusActive && styles.statusActive]} numberOfLines={1}>
            {statusText}
          </Text>
        </View>
      ) : null}
      {action}
    </>
  );

  if (!onPress) {
    return <View style={styles.row}>{content}</View>;
  }

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    flexDirection: "row",
    gap: 11,
    minHeight: 64,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  titleLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    minWidth: 0,
  },
  title: {
    color: theme.colors.text,
    flexShrink: 1,
    fontSize: 15,
    fontWeight: "800",
  },
  meta: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    marginTop: 3,
  },
  trailing: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 4,
    justifyContent: "flex-end",
    minWidth: 54,
  },
  cachedBadge: {
    color: theme.colors.tint,
    fontSize: 11,
    fontWeight: "900",
    lineHeight: 15,
  },
  status: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "800",
  },
  statusActive: {
    color: theme.colors.tint,
  },
  likeBadge: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "900",
    lineHeight: 14,
  },
  pressed: {
    opacity: 0.78,
  },
});
