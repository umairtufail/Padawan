"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { logout } from "../../lib/api";
import { useToken, useUserName } from "../../lib/use-token";
import Logo from "../../components/logo";
import { btnGhost } from "../../components/ui";

const nav = [
  { href: "/dashboard", label: "Overview", exact: true },
  { href: "/dashboard/teach", label: "Teach Yoda", exact: false },
  { href: "/dashboard/skills", label: "Jedi Archives", exact: false },
  { href: "/dashboard/capture", label: "Capture", exact: false },
] as const;

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const token = useToken();
  const user = useUserName();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (token === null) router.replace("/login");
  }, [token, router]);

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center font-mono text-sm text-muted" role="status">
        Checking your credentials…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-bg/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
          <Logo href="/dashboard" />
          <nav aria-label="Dashboard" className="order-3 flex w-full flex-wrap items-center gap-1 sm:order-none sm:w-auto sm:flex-1">
            {nav.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold ${active ? "bg-surface-2 text-gold" : "text-fg hover:text-gold"}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="font-mono text-xs text-muted">{user ?? "Admin"}</span>
            <button type="button" className={btnGhost} onClick={() => logout("/")}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>
    </div>
  );
}
