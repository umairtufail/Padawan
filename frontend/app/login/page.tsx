"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, login } from "../../lib/api";
import Logo from "../../components/logo";
import YodaFigure from "../../components/yoda-figure";
import { btnPrimary, ErrorBox, Label } from "../../components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(username.trim(), password);
      router.replace("/dashboard");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError("Wrong username or password.");
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
        <h1 className="font-heading text-2xl font-black text-gold">Enter the Archives</h1>
        <label className="block">
          <Label>Username</Label>
          <input className={input} name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="block">
          <Label>Password</Label>
          <input className={input} name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <ErrorBox>{error}</ErrorBox>}
        <button type="submit" className={`${btnPrimary} w-full`} disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-center font-mono text-xs text-muted">Demo access: admin / admin</p>
      </form>
    </main>
  );
}
