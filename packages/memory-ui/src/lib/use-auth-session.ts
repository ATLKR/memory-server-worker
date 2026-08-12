import { useEffect, useState } from "react";
import { getUserInfo, isLoggedIn } from "./api";

interface AuthSessionState {
  ready: boolean;
  loggedIn: boolean;
  user: { email?: string; name?: string } | null;
}

const INITIAL_STATE: AuthSessionState = {
  ready: false,
  loggedIn: false,
  user: null,
};

/** Keep the server render and first client render identical, then read browser auth. */
export function useAuthSession(): AuthSessionState {
  const [session, setSession] = useState<AuthSessionState>(INITIAL_STATE);

  useEffect(() => {
    const loggedIn = isLoggedIn();
    setSession({
      ready: true,
      loggedIn,
      user: loggedIn ? getUserInfo() : null,
    });
  }, []);

  return session;
}
