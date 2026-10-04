import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * "admin": the backend's demo account (username + password, token issued by our backend).
 * "supabase": real accounts in Supabase Auth (email + password); Supabase issues the token.
 */
export const AUTH_MODE: "admin" | "supabase" = process.env.NEXT_PUBLIC_AUTH_MODE === "supabase" ? "supabase" : "admin";

let client: SupabaseClient | null = null;

/** The browser Supabase client. Uses only public values (project URL and publishable key). */
export function supabase(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error("Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
    }
    client = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}
