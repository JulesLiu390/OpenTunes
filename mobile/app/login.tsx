import { CameraView, type BarcodeScanningResult, scanFromURLAsync, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useAuth } from "@/components/AuthProvider";
import { ApiError } from "@/lib/auth";
import { parseInviteQrPayload, type InviteQrPayload } from "@/lib/invite";
import { theme } from "@/lib/theme";

type LoginParams = {
  key?: string | string[];
  base_url?: string | string[];
  baseUrl?: string | string[];
  api_base_url?: string | string[];
  apiBaseUrl?: string | string[];
};

export default function LoginScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<LoginParams>();
  const { isAuthenticated, loading, login } = useAuth();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [deepLinkHandled, setDeepLinkHandled] = useState(false);
  const [pendingInvite, setPendingInvite] = useState<InviteQrPayload | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);

  const deepLinkValue = useMemo<string | null>(() => {
    const key = firstParam(params.key);
    if (!key) {
      return null;
    }
    const apiBaseUrl =
      firstParam(params.base_url) ||
      firstParam(params.api_base_url) ||
      firstParam(params.baseUrl) ||
      firstParam(params.apiBaseUrl);
    const query = new URLSearchParams({ key });
    if (apiBaseUrl) {
      query.set("base_url", apiBaseUrl);
    }
    return `openband://login?${query.toString()}`;
  }, [params.apiBaseUrl, params.api_base_url, params.baseUrl, params.base_url, params.key]);

  const stageInvite = useCallback((payload: InviteQrPayload) => {
    setPendingInvite(payload);
    setScannerVisible(false);
    setScanLocked(false);
    setError("");
  }, []);

  const submitInvite = useCallback(
    async (payload: InviteQrPayload) => {
      setSubmitting(true);
      setError("");
      setScannerVisible(false);
      try {
        await login(payload.key, { apiBaseUrl: payload.apiBaseUrl });
        router.replace("/onboarding" as never);
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError("Could not sign in.");
        }
      } finally {
        setSubmitting(false);
        setScanLocked(false);
      }
    },
    [login, router],
  );

  const stageQrData = useCallback(
    (value: string) => {
      stageInvite(parseInviteQrPayload(value));
    },
    [stageInvite],
  );

  useEffect(() => {
    if (deepLinkValue && !deepLinkHandled) {
      setDeepLinkHandled(true);
      try {
        stageQrData(deepLinkValue);
      } catch (err) {
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError("Could not read that invite link.");
        }
      }
    }
  }, [deepLinkHandled, deepLinkValue, stageQrData]);

  if (!loading && isAuthenticated && !submitting) {
    return <Redirect href="/" />;
  }

  async function startCameraScan() {
    setError("");
    setPendingInvite(null);
    setScanLocked(false);
    if (Platform.OS === "web") {
      setScannerVisible(true);
      return;
    }
    const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (!permission.granted) {
      setError("Camera permission is required to scan an invite QR code.");
      return;
    }
    setScannerVisible(true);
  }

  async function uploadQrImage() {
    setError("");
    setPendingInvite(null);
    setUploading(true);
    try {
      if (Platform.OS !== "web") {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(false);
        if (!permission.granted) {
          setError("Photo library permission is required to upload an invite QR code.");
          return;
        }
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        allowsMultipleSelection: false,
        mediaTypes: ["images"],
        quality: 1,
      });
      if (result.canceled) {
        return;
      }

      const uri = result.assets[0]?.uri;
      if (!uri) {
        setError("No image was selected.");
        return;
      }

      const scans = await scanFromURLAsync(uri, ["qr"]);
      const qrData = scans.find((scan) => scan.data)?.data;
      if (!qrData) {
        setError("No OpenTunes QR code was found in that image.");
        return;
      }
      stageQrData(qrData);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Could not read that QR image.");
      }
    } finally {
      setUploading(false);
    }
  }

  function handleBarcodeScanned(result: BarcodeScanningResult) {
    if (scanLocked || submitting || uploading) {
      return;
    }
    setScanLocked(true);
    try {
      stageQrData(result.data);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Could not read that QR code.");
      }
      setScanLocked(false);
    }
  }

  const busy = submitting || uploading;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.root}>
        <View style={styles.content}>
          <View style={styles.brand}>
            <View style={styles.mark}>
              <Text style={styles.markText}>♪</Text>
            </View>
            <Text style={styles.title}>OpenTunes</Text>
            <Text style={styles.subtitle}>Private, friends-only music.</Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>Invite QR</Text>
            {scannerVisible ? (
              <View style={styles.scannerFrame}>
                <CameraView
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  facing="back"
                  onBarcodeScanned={scanLocked || busy ? undefined : handleBarcodeScanned}
                  style={StyleSheet.absoluteFill}
                />
                <View pointerEvents="none" style={styles.scanGuide}>
                  <View style={styles.scanCorner} />
                </View>
              </View>
            ) : pendingInvite ? (
              <View style={styles.confirmPanel}>
                <Text style={styles.confirmTitle}>Confirm invite</Text>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmLabel}>Base URL</Text>
                  <Text numberOfLines={3} style={styles.confirmValue}>
                    {pendingInvite.apiBaseUrl}
                  </Text>
                </View>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmLabel}>Invite Token</Text>
                  <Text numberOfLines={1} style={styles.confirmValue}>
                    {shortInviteKey(pendingInvite.key)}
                  </Text>
                </View>
              </View>
            ) : (
              <View style={styles.idlePanel}>
                <Text style={styles.idleTitle}>Scan your invite</Text>
                <Text style={styles.idleText}>Use the camera or choose a QR image from your library.</Text>
              </View>
            )}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={pendingInvite ? () => submitInvite(pendingInvite) : startCameraScan}
                style={({ pressed }) => [
                  styles.button,
                  busy && styles.buttonDisabled,
                  pressed && !busy && styles.buttonPressed,
                ]}>
                {submitting ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.buttonText}>
                    {pendingInvite ? "Confirm Login" : scannerVisible ? "Scanning..." : "Scan QR"}
                  </Text>
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={
                  pendingInvite
                    ? () => {
                        setPendingInvite(null);
                        setScannerVisible(false);
                        setScanLocked(false);
                        setError("");
                      }
                    : uploadQrImage
                }
                style={({ pressed }) => [
                  styles.secondaryButton,
                  busy && styles.buttonDisabled,
                  pressed && !busy && styles.buttonPressed,
                ]}>
                {uploading ? (
                  <ActivityIndicator color={theme.colors.tint} />
                ) : (
                  <Text style={styles.secondaryButtonText}>{pendingInvite ? "Different QR" : "Upload QR"}</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>

        <Text style={styles.footer}>Non-profit beta for friends.</Text>
      </View>
    </SafeAreaView>
  );
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function shortInviteKey(value: string): string {
  if (value.length <= 22) {
    return value;
  }
  return `${value.slice(0, 12)}...${value.slice(-8)}`;
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  root: {
    flex: 1,
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingBottom: 22,
    paddingTop: 34,
  },
  content: {
    flex: 1,
    justifyContent: "center",
    gap: 34,
    width: "100%",
  },
  brand: {
    alignItems: "center",
    gap: 10,
  },
  mark: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: 8,
    height: 62,
    justifyContent: "center",
    width: 62,
  },
  markText: {
    color: "#FFFFFF",
    fontSize: 34,
    fontWeight: "900",
    lineHeight: 38,
  },
  title: {
    color: theme.colors.text,
    fontSize: 34,
    fontWeight: "900",
    letterSpacing: 0,
    lineHeight: 40,
  },
  subtitle: {
    color: theme.colors.secondaryText,
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 20,
  },
  form: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
    padding: 16,
  },
  label: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0,
    lineHeight: 16,
    textTransform: "uppercase",
  },
  idlePanel: {
    alignItems: "center",
    backgroundColor: theme.colors.elevated,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
    minHeight: 180,
    justifyContent: "center",
    padding: 18,
  },
  idleTitle: {
    color: theme.colors.text,
    fontSize: 22,
    fontWeight: "900",
    lineHeight: 28,
  },
  idleText: {
    color: theme.colors.secondaryText,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
    maxWidth: 250,
    textAlign: "center",
  },
  confirmPanel: {
    backgroundColor: theme.colors.elevated,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
    minHeight: 180,
    padding: 16,
  },
  confirmTitle: {
    color: theme.colors.text,
    fontSize: 22,
    fontWeight: "900",
    lineHeight: 28,
  },
  confirmRow: {
    gap: 4,
  },
  confirmLabel: {
    color: theme.colors.tertiaryText,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0,
    lineHeight: 14,
    textTransform: "uppercase",
  },
  confirmValue: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "800",
    lineHeight: 18,
  },
  scannerFrame: {
    backgroundColor: "#111111",
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    height: 260,
    overflow: "hidden",
  },
  scanGuide: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  scanCorner: {
    borderColor: "#FFFFFF",
    borderRadius: 8,
    borderWidth: 3,
    height: 150,
    opacity: 0.9,
    width: 150,
  },
  error: {
    color: theme.colors.tint,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  actions: {
    gap: 10,
  },
  button: {
    alignItems: "center",
    backgroundColor: theme.colors.tint,
    borderRadius: theme.radius.sm,
    height: 48,
    justifyContent: "center",
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: theme.colors.elevated,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    height: 48,
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonPressed: {
    opacity: 0.82,
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "900",
    lineHeight: 20,
  },
  secondaryButtonText: {
    color: theme.colors.tint,
    fontSize: 15,
    fontWeight: "900",
    lineHeight: 20,
  },
  footer: {
    color: theme.colors.tertiaryText,
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 18,
    textAlign: "center",
  },
});
