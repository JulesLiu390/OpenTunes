import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useAuth } from "@/components/AuthProvider";
import { ApiError } from "@/lib/auth";
import { generateMusicProfile, getMusicTags } from "@/lib/taste";
import { theme } from "@/lib/theme";

export default function OnboardingScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const [profileInput, setProfileInput] = useState("");
  const [currentTags, setCurrentTags] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function loadTags() {
      if (!session) {
        return;
      }
      try {
        const response = await getMusicTags(session.accessToken);
        if (mounted) {
          setCurrentTags(response.tags);
        }
      } catch {
        if (mounted) {
          setCurrentTags([]);
        }
      }
    }

    loadTags();

    return () => {
      mounted = false;
    };
  }, [session]);

  async function submit() {
    if (!session || submitting) {
      return;
    }
    const input = profileInput.trim();
    if (!input) {
      setError("Tell OpenTunes what you like first.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      await generateMusicProfile(session.accessToken, {
        profile_input: input,
        save: true,
      });
      router.replace("/");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Could not generate taste tags.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function skip() {
    router.replace("/");
  }

  const disabled = submitting || !session;

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.root}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.header}>
            <Text style={styles.eyebrow}>Taste Setup</Text>
            <Text style={styles.title}>What do you love?</Text>
            <Text style={styles.subtitle}>
              OpenTunes will turn your favorite artists, songs, sounds, moods, and dislikes into music taste tags.
            </Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>Message</Text>
            <TextInput
              autoCapitalize="sentences"
              multiline
              onChangeText={setProfileInput}
              placeholder="I like Linkin Park, Ado, sad synths, fast drums, heavy guitars, emotional vocals, and I do not like sweet pop or generic EDM drops."
              placeholderTextColor={theme.colors.tertiaryText}
              style={[styles.input, styles.textarea]}
              textAlignVertical="top"
              value={profileInput}
            />
          </View>

          {currentTags.length ? (
            <View style={styles.currentBlock}>
              <Text style={styles.currentTitle}>Current Tags</Text>
              <View style={styles.tagWrap}>
                {currentTags.slice(0, 16).map((tag) => (
                  <View key={tag} style={styles.tag}>
                    <Text style={styles.tagText}>{tag}</Text>
                  </View>
                ))}
                {currentTags.length > 16 ? (
                  <View style={styles.tag}>
                    <Text style={styles.tagText}>...</Text>
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={submit}
              style={({ pressed }) => [styles.primaryButton, disabled && styles.disabled, pressed && !disabled && styles.pressed]}>
              {submitting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>Generate Tags</Text>}
            </Pressable>
            <Pressable accessibilityRole="button" onPress={skip} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
              <Text style={styles.secondaryText}>{currentTags.length ? "Keep Current" : "Skip For Now"}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    backgroundColor: theme.colors.background,
    flex: 1,
  },
  root: {
    flex: 1,
  },
  content: {
    gap: 18,
    paddingBottom: 28,
    paddingHorizontal: 22,
    paddingTop: 34,
  },
  header: {
    gap: 8,
  },
  eyebrow: {
    color: theme.colors.tint,
    fontSize: 14,
    fontWeight: "900",
    letterSpacing: 0,
  },
  title: {
    color: theme.colors.text,
    fontSize: 38,
    fontWeight: "900",
    letterSpacing: 0,
    lineHeight: 42,
  },
  subtitle: {
    color: theme.colors.secondaryText,
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 21,
  },
  form: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 13,
    padding: 14,
  },
  label: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  input: {
    backgroundColor: theme.colors.elevated,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  textarea: {
    minHeight: 220,
    textAlignVertical: "top",
  },
  currentBlock: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    gap: 10,
    padding: 14,
  },
  currentTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "900",
  },
  tagWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tag: {
    backgroundColor: theme.colors.tintSoft,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  tagText: {
    color: theme.colors.tint,
    fontSize: 12,
    fontWeight: "900",
  },
  error: {
    color: theme.colors.tint,
    fontSize: 13,
    fontWeight: "800",
    lineHeight: 18,
  },
  actions: {
    gap: 10,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: theme.radius.sm,
    height: 50,
    justifyContent: "center",
  },
  primaryText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "900",
  },
  secondaryButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
  },
  secondaryText: {
    color: theme.colors.secondaryText,
    fontSize: 14,
    fontWeight: "900",
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.78,
  },
});
