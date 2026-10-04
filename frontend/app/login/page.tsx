"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, login, loginWithSupabase, signUpWithSupabase } from "../../lib/api";
import { AUTH_MODE } from "../../lib/supabase";
import Logo from "../../components/logo";
import YodaFigure from "../../components/yoda-figure";
import { btnPrimary, ErrorBox, Label } from "../../components/ui";

export default function LoginPage() {
  const router = useRouter();
  const useSupabase = AUTH_MODE === "supabase";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (useSupabase && creating) {
        if (password.length < 8) throw new Error("Use at least 8 characters for the password.");
        const result = await signUpWithSupabase(username.trim(), password);
        if (result === "confirm_email") {
          setNotice("Almost there: we sent a confirmation link to your email. Open it to enter the Archives.");
          setBusy(false);
          return;
        }
      } else if (useSupabase) await loginWithSupabase(username.trim(), password);
      else await login(username.trim(), password);
      router.replace("/dashboard");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError(useSupabase ? "Wrong email or password." : "Wrong username or password.");
      else if (err instanceof ApiError && err.status === 0) setError(err.message + ". Is the backend running?");
      else setError(err instanceof Error ? err.message : "Sign in failed.");
      setBusy(false);
    }
  }

  const input =
    "mt-2 w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-fg placeholder:text-muted/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-info";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-10">
      <div className="mb-8 flex flex-col items-center gap-5">
        <YodaFigure size={120} />
        <Logo />
      </div>
      <form onSubmit={onSubmit} className="space-y-5 rounded-2xl border border-line bg-surface/90 p-6" noValidate>
        <h1 className="font-heading text-2xl font-black text-gold">{creating ? "Join the Archives" : "Enter the Archives"}</h1>
        <label className="block">
          <Label>{useSupabase ? "Email" : "Username"}</Label>
          <input className={input} name="username" type={useSupabase ? "email" : "text"} autoComplete={useSupabase ? "email" : "username"} value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="block">
          <Label>Password</Label>
          <input className={input} name="password" type="password" autoComplete={creating ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <ErrorBox>{error}</ErrorBox>}
        {notice && <p role="status" className="rounded-lg border border-jade/40 bg-jade/10 px-3 py-2 text-sm text-fg">{notice}</p>}
        <button type="submit" className={`${btnPrimary} w-full`} disabled={busy || !username || !password}>
          {busy ? (creating ? "Creating…" : "Signing in…") : creating ? "Create account" : "Sign in"}
        </button>
        {useSupabase ? (
          <p className="text-center font-mono text-xs text-muted">
            {creating ? "Already have an account?" : "New here?"}{" "}
            <button type="button" className="text-info underline underline-offset-4" onClick={() => { setCreating(!creating); setError(""); setNotice(""); }}>
              {creating ? "Sign in" : "Create an account"}
            </button>
          </p>
        ) : (
          <p className="text-center font-mono text-xs text-muted">Demo access: admin / admin</p>
        )}
      </form>
    </main>
  );
}
