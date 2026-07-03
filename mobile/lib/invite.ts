import { normalizeApiBaseUrl } from "@/lib/auth";

export type InviteQrPayload = {
  key: string;
  apiBaseUrl: string;
};

const INVITE_KEY_PREFIX = "ob_key_";

export function parseInviteQrPayload(value: string): InviteQrPayload {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new Error("The QR code is empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmedValue);
  } catch {
    throw new Error("This QR code is not an OpenTunes invite.");
  }

  const key =
    parsed.searchParams.get("key") ||
    parsed.searchParams.get("invite_key") ||
    parsed.searchParams.get("inviteKey") ||
    "";
  if (!key.startsWith(INVITE_KEY_PREFIX)) {
    throw new Error("This QR code does not contain an OpenTunes invite key.");
  }

  const apiBaseUrlValue =
    parsed.searchParams.get("base_url") ||
    parsed.searchParams.get("api_base_url") ||
    parsed.searchParams.get("baseUrl") ||
    parsed.searchParams.get("apiBaseUrl") ||
    "";
  if (!apiBaseUrlValue) {
    throw new Error("This invite QR code is missing the API base URL.");
  }

  return {
    key,
    apiBaseUrl: normalizeApiBaseUrl(apiBaseUrlValue),
  };
}
