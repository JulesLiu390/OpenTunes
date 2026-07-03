import { PropsWithChildren, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

import {
  ApiError,
  AuthSession,
  AuthUser,
  clearStoredSession,
  getMe,
  isAccessTokenFresh,
  loadStoredApiBaseUrl,
  loadStoredSession,
  loginWithInviteKey,
  logoutSession,
  refreshAuthSession,
  saveStoredSession,
  subscribeAuthSession,
  updateMe,
} from "@/lib/auth";

type AuthContextValue = {
  user: AuthUser | null;
  session: AuthSession | null;
  loading: boolean;
  isAuthenticated: boolean;
  login: (key: string, options?: { apiBaseUrl?: string }) => Promise<void>;
  logout: () => Promise<void>;
  updateProfileName: (label: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const applySession = useCallback(async (nextSession: AuthSession) => {
    setSession(nextSession);
    setUser(nextSession.user);
    await saveStoredSession(nextSession);
  }, []);

  useEffect(() => {
    return subscribeAuthSession((nextSession) => {
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
    });
  }, []);

  useEffect(() => {
    let mounted = true;

    async function restoreSession() {
      try {
        const storedSession = await loadStoredSession();
        if (!storedSession) {
          await loadStoredApiBaseUrl();
          return;
        }

        if (isAccessTokenFresh(storedSession)) {
          let currentUser: AuthUser;
          try {
            currentUser = await getMe(storedSession.accessToken);
          } catch (exc) {
            if (shouldClearStoredSession(exc)) {
              await clearStoredSession();
              return;
            }
            if (mounted) {
              setSession(storedSession);
              setUser(storedSession.user);
            }
            return;
          }
          if (mounted) {
            const nextSession = { ...storedSession, user: currentUser };
            setSession(nextSession);
            setUser(currentUser);
            await saveStoredSession(nextSession);
          }
          return;
        }

        let refreshedSession: AuthSession;
        try {
          refreshedSession = await refreshAuthSession(storedSession.refreshToken);
        } catch (exc) {
          if (shouldClearStoredSession(exc)) {
            await clearStoredSession();
            return;
          }
          if (mounted) {
            setSession(storedSession);
            setUser(storedSession.user);
          }
          return;
        }
        if (mounted) {
          setSession(refreshedSession);
          setUser(refreshedSession.user);
        }
        await saveStoredSession(refreshedSession);
      } catch {
        await clearStoredSession();
        if (mounted) {
          setSession(null);
          setUser(null);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    restoreSession();

    return () => {
      mounted = false;
    };
  }, []);

  const login = useCallback(
    async (key: string, options?: { apiBaseUrl?: string }) => {
      const nextSession = await loginWithInviteKey(key, `OpenTunes ${Platform.OS}`, options?.apiBaseUrl);
      await applySession(nextSession);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    const currentSession = session;
    try {
      if (currentSession) {
        await logoutSession(currentSession.accessToken, currentSession.refreshToken);
      }
    } catch {
      // Local logout should succeed even if the access token has already expired.
    } finally {
      setSession(null);
      setUser(null);
      await clearStoredSession();
    }
  }, [session]);

  const updateProfileName = useCallback(
    async (label: string) => {
      const currentSession = session;
      if (!currentSession) {
        throw new ApiError("Missing auth session.", 401);
      }
      const updatedUser = await updateMe(currentSession.accessToken, { label });
      const storedSession = await loadStoredSession();
      const baseSession = storedSession?.user.id === updatedUser.id ? storedSession : currentSession;
      const nextSession = { ...baseSession, user: updatedUser };
      setSession(nextSession);
      setUser(updatedUser);
      await saveStoredSession(nextSession);
    },
    [session],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      loading,
      isAuthenticated: Boolean(user && session),
      login,
      logout,
      updateProfileName,
    }),
    [loading, login, logout, session, updateProfileName, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function shouldClearStoredSession(exc: unknown): boolean {
  return exc instanceof ApiError && (exc.status === 401 || exc.status === 403);
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }
  return value;
}
