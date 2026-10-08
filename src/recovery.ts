import type { CookieStatus, QueueItem } from "./types";

export function cookiesMatch(status: CookieStatus, profile: string): boolean {
  return Boolean(profile && status.syncedAt && status.profile?.toLowerCase() === profile.toLowerCase());
}

export function markCookiesRefreshed(items: QueueItem[]): QueueItem[] {
  return items.map(item => item.status === "failed" && item.recoveryReason && item.recoveryReason !== "runtimeUnsupported"
    ? { ...item, cookiesRefreshed: true, recoveryError: undefined } : item);
}

export function hasCookieOverride(args: string[], raw: string): boolean {
  return args.some(arg => /^--(?:no-)?cookies(?:-from-browser)?(?:=|$)/.test(arg)) ||
    /(?:^|\s|["'])--(?:no-)?cookies(?:-from-browser)?(?=[=\s"']|$)/.test(raw);
}
