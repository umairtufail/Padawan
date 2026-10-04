"use client";

import { useEffect } from "react";
import { setSession, syncSupabaseToken } from "../lib/api";
import { AUTH_MODE, supabase } from "../lib/supabase";

/**
 * Supabase mode only: mirrors Supabase's session (sign in, token renewal, sign out, also from another tab)
 * into the token the rest of the app reads. Renders nothing.
 */
export default function AuthSync() {
  useEffect(() => {
    if (AUTH_MODE !== "supabase") return;
    void syncSupabaseToken();
    const { data } = supabase().auth.onAuthStateChange((_event, session) => {
      if (session) setSession(session.access_token, session.user.email ?? "User");
    });
    return () => data.subscription.unsubscribe();
  }, []);
  return null;
}
