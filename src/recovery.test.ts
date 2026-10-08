import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { RecoveryPanel } from "./CookieControls";
import { translator } from "./i18n";
import { DEFAULT_SETTINGS } from "./settings";
import { cookiesMatch, hasCookieOverride, markCookiesRefreshed } from "./recovery";
import type { QueueItem } from "./types";

const item: QueueItem = { id: "test", url: "https://youtube.com/watch?v=x", destination: "Downloads", preset: "video", status: "failed", recoveryReason: "authorization" };
const noop = () => {};
function panel(patch: Partial<Parameters<typeof RecoveryPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(RecoveryPanel, { item, settings: DEFAULT_SETTINGS, status: {}, busy: false, overridden: false, t: translator("en"), sync: noop, setup: noop, logs: noop, advanced: noop, retry: noop, updateTool: noop, ...patch }));
}

describe("cookie recovery", () => {
  it("guides setup then offers sync and explicit retry", () => {
    expect(panel()).toContain("Set up Firefox cookies");
    const settings = { ...DEFAULT_SETTINGS, cookiesEnabled: true, firefoxProfile: "profile" };
    expect(panel({ settings })).toContain("Resync cookies");
    expect(panel({ settings })).not.toContain("Retry download");
    const refreshed = markCookiesRefreshed([item])[0];
    const html = panel({ settings, item: refreshed, status: { profile: "profile", syncedAt: 100 } });
    expect(html).toContain("Cookies refreshed"); expect(html).toContain("Retry download");
    expect(refreshed.status).toBe("failed");
    expect(panel({ settings, item: refreshed, status: { profile: "other", syncedAt: 100 } })).not.toContain("Retry download");
  });
  it("shows sync failures, disables repeated sync, and explains overrides", () => {
    const settings = { ...DEFAULT_SETTINGS, cookiesEnabled: true, firefoxProfile: "profile" };
    expect(panel({ settings, busy: true })).toContain("disabled");
    expect(panel({ item: { ...item, recoveryError: "Read failed" } })).toContain("Read failed");
    expect(panel({ settings, overridden: true })).toContain("Review advanced cookie options");
    expect(panel({ settings, overridden: true, item: { ...item, cookiesRefreshed: true } })).not.toContain("Retry download");
  });
  it("omits recovery for completed/cancelled jobs and explains access and runtime errors", () => {
    expect(panel({ item: { ...item, status: "completed" } })).toBe("");
    expect(panel({ item: { ...item, status: "cancelled" } })).toBe("");
    expect(panel({ item: { ...item, recoveryReason: "accountAccess" } })).toContain("must have access");
    expect(panel({ item: { ...item, recoveryReason: "runtimeUnsupported" } })).toContain("Update yt-dlp");
  });
  it("compares profiles and catches cookie overrides", () => {
    expect(cookiesMatch({ profile: "PROFILE", syncedAt: 1 }, "profile")).toBe(true);
    expect(cookiesMatch({}, "profile")).toBe(false);
    for (const flag of ["--cookies", "--cookies-from-browser=firefox", "--no-cookies"]) expect(hasCookieOverride([flag], "")).toBe(true);
    expect(hasCookieOverride([], '--cookies "C:\\My cookies.txt"')).toBe(true);
    expect(hasCookieOverride([], "--write-thumbnail")).toBe(false);
  });
  it("renders localized recovery in Ukrainian", () => {
    expect(panel({ t: translator("uk") })).toContain("Налаштувати cookies Firefox");
  });
});
