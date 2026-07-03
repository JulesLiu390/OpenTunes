import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Section } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { MusicPage } from "@/components/MusicPage";
import {
  DownloadLocation,
  downloadLocationDescription,
  downloadLocationLabel,
  getDownloadSettings,
  setDownloadLocation as saveDownloadLocation,
} from "@/lib/songs";
import { getMusicTags, loadCachedMusicTags, subscribeMusicTags } from "@/lib/taste";
import { theme } from "@/lib/theme";
import { APP_VERSION } from "@/lib/version";

export default function MeScreen() {
  const router = useRouter();
  const { session, user, logout, updateProfileName } = useAuth();
  const [editName, setEditName] = useState("");
  const [editNameError, setEditNameError] = useState<string | null>(null);
  const [editNameVisible, setEditNameVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [logoutConfirmVisible, setLogoutConfirmVisible] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [downloadLocation, setDownloadLocationState] = useState<DownloadLocation>("app");
  const [downloadSettingsVisible, setDownloadSettingsVisible] = useState(false);
  const [savingDownloadLocation, setSavingDownloadLocation] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const sortedTags = useMemo(() => [...tags].sort((left, right) => left.localeCompare(right)), [tags]);
  const versionText = APP_VERSION;

  const loadTags = useCallback(async () => {
    if (!session) {
      return;
    }
    setLoading(true);
    try {
      const cached = await loadCachedMusicTags(session.user.id);
      if (cached) {
        setTags(cached.tags);
        setUpdatedAt(cached.updated_at);
      }
      const response = await getMusicTags(session.accessToken);
      setTags(response.tags);
      setUpdatedAt(response.updated_at);
    } catch {
      const cached = await loadCachedMusicTags(session.user.id);
      if (cached) {
        setTags(cached.tags);
        setUpdatedAt(cached.updated_at);
      } else {
        setTags([]);
        setUpdatedAt(null);
      }
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    return subscribeMusicTags((response) => {
      setTags(response.tags);
      setUpdatedAt(response.updated_at);
    });
  }, []);

  useEffect(() => {
    if (!session) {
      setDownloadLocationState("app");
      return;
    }
    getDownloadSettings(session.user.id)
      .then((settings) => setDownloadLocationState(settings.location))
      .catch(() => setDownloadLocationState("app"));
  }, [session]);

  useFocusEffect(
    useCallback(() => {
      loadTags();
    }, [loadTags]),
  );

  async function submitLogout() {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    try {
      await logout();
      setLogoutConfirmVisible(false);
      router.replace("/login");
    } finally {
      setLoggingOut(false);
    }
  }

  function openNameEditor() {
    setEditName(user?.label ?? "");
    setEditNameError(null);
    setEditNameVisible(true);
  }

  function closeNameEditor() {
    if (savingName) {
      return;
    }
    setEditNameVisible(false);
    setEditName("");
    setEditNameError(null);
  }

  async function submitName() {
    const name = editName.trim();
    if (!name || savingName) {
      return;
    }
    setSavingName(true);
    setEditNameError(null);
    try {
      await updateProfileName(name);
      setEditNameVisible(false);
      setEditName("");
      setEditNameError(null);
    } catch (exc) {
      setEditNameError(exc instanceof Error ? exc.message : "Name could not be updated.");
    } finally {
      setSavingName(false);
    }
  }

  async function chooseDownloadLocation(location: DownloadLocation) {
    if (!session || savingDownloadLocation) {
      return;
    }
    setSavingDownloadLocation(true);
    try {
      const settings = await saveDownloadLocation(session.user.id, location);
      setDownloadLocationState(settings.location);
      setDownloadSettingsVisible(false);
    } finally {
      setSavingDownloadLocation(false);
    }
  }

  return (
    <MusicPage>
      <Section>
        <Text style={styles.eyebrow}>Profile</Text>
        <Text style={styles.title}>Me</Text>
      </Section>

      <Section>
        <View style={styles.profilePanel}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initial(user?.label)}</Text>
          </View>
          <View style={styles.profileCopy}>
            <Text style={styles.name} numberOfLines={1}>
              {user?.label ?? "OpenTunes Friend"}
            </Text>
            <Text style={styles.meta}>{tags.length ? `${tags.length} taste tags` : "No taste tags yet"}</Text>
          </View>
          <Pressable
            accessibilityLabel="Edit profile name"
            accessibilityRole="button"
            onPress={openNameEditor}
            style={({ pressed }) => [styles.editButton, pressed && styles.pressed]}>
            <Text style={styles.editButtonText}>Edit</Text>
          </Pressable>
          {loading ? <ActivityIndicator color={theme.colors.tint} size="small" /> : null}
        </View>
      </Section>

      <Section>
        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.sectionTitle}>Taste Tags</Text>
            <Text style={styles.updatedText}>{updatedAt ? `Updated ${shortDate(updatedAt)}` : "Generated from onboarding"}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push("/taste-tags" as never)}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <Text style={styles.iconButtonText}>＋</Text>
          </Pressable>
        </View>
        {sortedTags.length ? (
          <View style={styles.tagWrap}>
            {sortedTags.map((tag) => (
              <View key={tag} style={styles.tag}>
                <Text style={styles.tagText}>{tag}</Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No taste profile</Text>
            <Text style={styles.emptyText}>Add favorites to generate your first music tags.</Text>
          </View>
        )}
      </Section>

      <Section>
        <View style={styles.downloadPanel}>
          <View style={styles.profileCopy}>
            <Text style={styles.versionLabel}>Download Location</Text>
            <Text style={styles.downloadMeta}>{downloadLocationLabel(downloadLocation)}</Text>
            <Text style={styles.downloadDescription}>{downloadLocationDescription(downloadLocation)}</Text>
          </View>
          <Pressable
            accessibilityLabel="Change download location"
            accessibilityRole="button"
            onPress={() => setDownloadSettingsVisible(true)}
            style={({ pressed }) => [styles.editButton, pressed && styles.pressed]}>
            <Text style={styles.editButtonText}>Change</Text>
          </Pressable>
        </View>
      </Section>

      <Section>
        <View style={styles.versionPanel}>
          <Text style={styles.versionLabel}>Version</Text>
          <Text style={styles.versionText}>{versionText}</Text>
        </View>
      </Section>

      <Section>
        <Pressable
          accessibilityRole="button"
          onPress={() => setLogoutConfirmVisible(true)}
          style={({ pressed }) => [styles.logoutButton, pressed && styles.pressed]}>
          <Text style={styles.logoutText}>Log Out</Text>
        </Pressable>
      </Section>

      <Modal
        animationType="fade"
        transparent
        visible={logoutConfirmVisible}
        onRequestClose={() => {
          if (!loggingOut) {
            setLogoutConfirmVisible(false);
          }
        }}>
        <View style={styles.modalRoot}>
          <Pressable
            accessibilityLabel="Cancel log out"
            disabled={loggingOut}
            onPress={() => setLogoutConfirmVisible(false)}
            style={styles.backdrop}
          />
          <View style={styles.confirmPanel}>
            <Text style={styles.confirmTitle}>Log out?</Text>
            <Text style={styles.confirmText}>
              Once you log out, you will need an administrator to generate a new QR code before you can sign in again.
            </Text>
            <View style={styles.confirmActions}>
              <Pressable
                accessibilityRole="button"
                disabled={loggingOut}
                onPress={() => setLogoutConfirmVisible(false)}
                style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed, loggingOut && styles.disabled]}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={loggingOut}
                onPress={submitLogout}
                style={({ pressed }) => [styles.confirmButton, pressed && styles.pressed, loggingOut && styles.disabled]}>
                <Text style={styles.confirmButtonText}>{loggingOut ? "Logging Out" : "Log Out"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        transparent
        visible={editNameVisible}
        onRequestClose={closeNameEditor}>
        <View style={styles.modalRoot}>
          <Pressable
            accessibilityLabel="Cancel profile name edit"
            disabled={savingName}
            onPress={closeNameEditor}
            style={styles.backdrop}
          />
          <View style={styles.confirmPanel}>
            <Text style={styles.confirmTitle}>Profile name</Text>
            <TextInput
              autoCapitalize="words"
              editable={!savingName}
              onChangeText={setEditName}
              onSubmitEditing={submitName}
              placeholder="Your name"
              placeholderTextColor={theme.colors.tertiaryText}
              returnKeyType="done"
              style={styles.nameInput}
              value={editName}
            />
            {editNameError ? <Text style={styles.errorText}>{editNameError}</Text> : null}
            <View style={styles.confirmActions}>
              <Pressable
                accessibilityRole="button"
                disabled={savingName}
                onPress={closeNameEditor}
                style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed, savingName && styles.disabled]}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!editName.trim() || savingName}
                onPress={submitName}
                style={({ pressed }) => [
                  styles.confirmButton,
                  pressed && styles.pressed,
                  (!editName.trim() || savingName) && styles.disabled,
                ]}>
                <Text style={styles.confirmButtonText}>{savingName ? "Saving" : "Save"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        transparent
        visible={downloadSettingsVisible}
        onRequestClose={() => {
          if (!savingDownloadLocation) {
            setDownloadSettingsVisible(false);
          }
        }}>
        <View style={styles.modalRoot}>
          <Pressable
            accessibilityLabel="Cancel download location change"
            disabled={savingDownloadLocation}
            onPress={() => setDownloadSettingsVisible(false)}
            style={styles.backdrop}
          />
          <View style={styles.confirmPanel}>
            <Text style={styles.confirmTitle}>Download location</Text>
            <Text style={styles.confirmText}>Choose where new manual downloads are stored on this device.</Text>
            <View style={styles.locationOptions}>
              {(["app", "temporary"] as DownloadLocation[]).map((location) => {
                const selected = downloadLocation === location;
                return (
                  <Pressable
                    accessibilityRole="button"
                    disabled={savingDownloadLocation}
                    key={location}
                    onPress={() => chooseDownloadLocation(location)}
                    style={({ pressed }) => [
                      styles.locationOption,
                      selected && styles.locationOptionSelected,
                      pressed && styles.pressed,
                      savingDownloadLocation && styles.disabled,
                    ]}>
                    <View style={styles.locationCopy}>
                      <Text style={[styles.locationTitle, selected && styles.locationTitleSelected]}>
                        {downloadLocationLabel(location)}
                      </Text>
                      <Text style={styles.locationDescription}>{downloadLocationDescription(location)}</Text>
                    </View>
                    <Text style={[styles.locationCheck, selected && styles.locationCheckSelected]}>{selected ? "✓" : ""}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={savingDownloadLocation}
              onPress={() => setDownloadSettingsVisible(false)}
              style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed, savingDownloadLocation && styles.disabled]}>
              <Text style={styles.cancelText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </MusicPage>
  );
}

function initial(label: string | undefined): string {
  const clean = (label || "O").trim();
  return clean.slice(0, 1).toUpperCase();
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
  profilePanel: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    flexDirection: "row",
    gap: 14,
    minHeight: 94,
    padding: 14,
  },
  avatar: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: theme.radius.md,
    height: 62,
    justifyContent: "center",
    width: 62,
  },
  avatarText: {
    color: "#FFFFFF",
    fontSize: 28,
    fontWeight: "900",
  },
  profileCopy: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: theme.colors.text,
    fontSize: 21,
    fontWeight: "900",
  },
  meta: {
    color: theme.colors.secondaryText,
    fontSize: 13,
    fontWeight: "700",
    marginTop: 5,
  },
  editButton: {
    alignItems: "center",
    backgroundColor: theme.colors.tintSoft,
    borderRadius: theme.radius.pill,
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  editButtonText: {
    color: theme.colors.tint,
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
  updatedText: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 3,
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  iconButtonText: {
    color: theme.colors.tint,
    fontSize: 24,
    fontWeight: "900",
    lineHeight: 26,
  },
  tagWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tag: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  tagText: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  emptyState: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    gap: 4,
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
  logoutButton: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    height: 48,
    justifyContent: "center",
  },
  versionPanel: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 50,
    paddingHorizontal: 14,
  },
  downloadPanel: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    flexDirection: "row",
    gap: 12,
    minHeight: 78,
    padding: 14,
  },
  downloadMeta: {
    color: theme.colors.tint,
    fontSize: 13,
    fontWeight: "900",
    marginTop: 4,
  },
  downloadDescription: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17,
    marginTop: 3,
  },
  versionLabel: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "900",
  },
  versionText: {
    color: theme.colors.secondaryText,
    fontSize: 13,
    fontWeight: "800",
  },
  logoutText: {
    color: theme.colors.tint,
    fontSize: 15,
    fontWeight: "900",
  },
  modalRoot: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  backdrop: {
    backgroundColor: "rgba(0,0,0,0.2)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  confirmPanel: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    gap: 12,
    maxWidth: 360,
    padding: 18,
    width: "100%",
  },
  confirmTitle: {
    color: theme.colors.text,
    fontSize: 21,
    fontWeight: "900",
  },
  confirmText: {
    color: theme.colors.secondaryText,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
  },
  nameInput: {
    backgroundColor: theme.colors.background,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "800",
    minHeight: 46,
    paddingHorizontal: 12,
  },
  errorText: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "800",
  },
  confirmActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  locationOptions: {
    gap: 8,
  },
  locationOption: {
    alignItems: "center",
    backgroundColor: theme.colors.background,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    minHeight: 74,
    padding: 12,
  },
  locationOptionSelected: {
    backgroundColor: theme.colors.tintSoft,
    borderColor: theme.colors.tint,
  },
  locationCopy: {
    flex: 1,
    minWidth: 0,
  },
  locationTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "900",
  },
  locationTitleSelected: {
    color: theme.colors.tint,
  },
  locationDescription: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17,
    marginTop: 3,
  },
  locationCheck: {
    color: theme.colors.tint,
    fontSize: 18,
    fontWeight: "900",
    width: 22,
  },
  locationCheckSelected: {
    color: theme.colors.tint,
  },
  cancelButton: {
    alignItems: "center",
    backgroundColor: theme.colors.background,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minHeight: 44,
    justifyContent: "center",
  },
  cancelText: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "900",
  },
  confirmButton: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: theme.radius.md,
    flex: 1,
    minHeight: 44,
    justifyContent: "center",
  },
  confirmButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "900",
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.76,
  },
});
