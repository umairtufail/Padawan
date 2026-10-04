"use client";

import { useEffect } from "react";
import { setSession, syncSupabaseToken } from "../lib/api";
import { AUTH_MODE, supabase } from "../lib/supabase";

/**
 * Supabase mode only: mirrors Supabase's session (sign in, token renewal, sign out, also from another tab)
 * into the token the rest of the app reads. Renders nothing.
 *
 * Also handles the link in Supabase's confirmation email: it opens the site with the session in the URL
 * (#access_token=...). supabase-js reads it and clears it, and we send the person to the dashboard.
 */
export default function AuthSync() {
  useEffect(() => {
    if (AUTH_MODE !== "supabase") return;
    const fromEmailLink = /[#&]access_token=/.test(window.location.hash);
    void syncSupabaseToken();
    const { data } = supabase().auth.onAuthStateChange((event, session) => {
      if (session) setSession(session.access_token, session.user.email ?? "User");
      if (fromEmailLink && session && event === "SIGNED_IN") window.location.replace("/dashboard");
    });
    return () => data.subscription.unsubscribe();
  }, []);
  return null;
}
