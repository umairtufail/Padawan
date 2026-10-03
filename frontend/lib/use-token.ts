"use client";

import { useSyncExternalStore } from "react";
import { getToken, getUserName } from "./api";

const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};

/** Current token, or null. Returns undefined during server render / hydration. */
export function useToken(): string | null | undefined {
  return useSyncExternalStore(subscribe, getToken, () => undefined);
}

export function useUserName(): string | null | undefined {
  return useSyncExternalStore(subscribe, getUserName, () => undefined);
}
