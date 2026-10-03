"use client";

import Link from "next/link";
import { useToken } from "../lib/use-token";
import { btnPrimary } from "./ui";

/** Landing-page links that point to the dashboard when a token exists. */
export function NavAuth() {
  const token = useToken();
  const signedIn = !!token;
  return (
    <nav className="flex items-center gap-3 sm:gap-5">
      {!signedIn && (
        <Link href="/login" className="text-sm font-semibold text-fg hover:text-gold">
          Sign in
        </Link>
      )}
      <Link href={signedIn ? "/dashboard" : "/login"} className={`${btnPrimary} !px-4 !py-2`}>
        {signedIn ? "Open dashboard" : "Enter the Archives"}
      </Link>
    </nav>
  );
}

export function HeroCta() {
  const token = useToken();
  return (
    <Link href={token ? "/dashboard" : "/login"} className={`${btnPrimary} !px-7 !py-3.5 !text-base`}>
      {token ? "Go to your dashboard" : "Teach Yoda"}
    </Link>
  );
}
