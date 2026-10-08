import { useEffect, useRef } from "react";
import type { translator } from "./i18n";
import type { AppSettings, CookieStatus, FirefoxProfile, QueueItem } from "./types";
import { cookiesMatch } from "./recovery";

type T = ReturnType<typeof translator>;
export function CookieControls({ settings, status, profiles, busy, error, focus, t, update, browse, sync, clear }: {
  settings: AppSettings; status: CookieStatus; profiles: FirefoxProfile[]; busy: boolean; error: string; focus: number; t: T;
  update: (patch: Partial<AppSettings>) => void; browse: () => void; sync: () => void; clear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focus) { input.current?.scrollIntoView({ block: "center" }); input.current?.focus(); } }, [focus]);
  return <section className="card cookie-card">
    <h2>{t("firefoxCookies")}</h2>
    <label className="checkbox-label"><input ref={input} type="checkbox" checked={settings.cookiesEnabled} disabled={busy} onChange={e => update({ cookiesEnabled: e.target.checked })} />{t("enableCookies")}</label>
    <p>{t("cookieInstructions")}</p>
    <label htmlFor="firefox-profile">{t("firefoxProfile")}</label>
    <select id="firefox-profile" value={settings.firefoxProfile} disabled={busy} onChange={e => update({ firefoxProfile: e.target.value })}>
      <option value="">{t("chooseProfile")}</option>
      {profiles.map(profile => <option key={profile.path} value={profile.path}>{profile.name}</option>)}
      {settings.firefoxProfile && !profiles.some(p => p.path === settings.firefoxProfile) && <option value={settings.firefoxProfile}>{settings.firefoxProfile}</option>}
    </select>
    <small className="profile-path">{settings.firefoxProfile || t("noFirefoxProfile")}</small>
    <CookieContext status={status} profile={settings.firefoxProfile} t={t} />
    <div className="tool-actions">
      <button disabled={busy} onClick={browse}>{t("customProfile")}</button>
      <button disabled={busy || !settings.firefoxProfile} onClick={sync}>{busy ? t("syncingCookies") : t("resyncCookies")}</button>
      <button disabled={busy || !status.syncedAt} onClick={clear}>{t("clearCookies")}</button>
    </div>
    <small aria-live="polite" className={error ? "warning-text" : ""}>{error}</small>
  </section>;
}

export function CookieContext({ status, profile, t }: { status: CookieStatus; profile: string; t: T }) {
  return <small>{cookiesMatch(status, profile) ? `${t("lastCookieSync")}: ${new Date(status.syncedAt! * 1000).toLocaleString()}` : t("noCookiesSynced")}</small>;
}

export function RecoveryPanel({ item, settings, status, busy, overridden, t, sync, setup, logs, advanced, retry, updateTool }: {
  item: QueueItem; settings: AppSettings; status: CookieStatus; busy: boolean; overridden: boolean; t: T;
  sync: () => void; setup: () => void; logs: () => void; advanced: () => void; retry: () => void; updateTool: () => void;
}) {
  if (item.status !== "failed" || !item.recoveryReason) return null;
  const runtime = item.recoveryReason === "runtimeUnsupported";
  const configured = settings.cookiesEnabled && Boolean(settings.firefoxProfile);
  return <div className="recovery-panel" role="region" aria-label={t("downloadRecovery")}>
    <p>{runtime ? t("runtimeUnsupported") : item.cookiesRefreshed && !overridden && cookiesMatch(status, settings.firefoxProfile) ? t("cookiesRefreshed") : t("authorizationProblem")}</p>
    {!runtime && <>
      <small>{t("cookieInstructions")}</small>
      {item.recoveryReason === "accountAccess" && <small>{t("accountAccessNeeded")}</small>}
      <small className="profile-path">{t("firefoxProfile")}: {settings.firefoxProfile || t("chooseProfile")}</small>
      <CookieContext status={status} profile={settings.firefoxProfile} t={t} />
      {overridden && <small className="warning-text">{t("cookiesOverridden")}</small>}
    </>}
    <div className="tool-actions">
      {runtime ? <button onClick={updateTool}>{t("updateTool")}</button> : overridden ? <button onClick={advanced}>{t("reviewCookieOptions")}</button> : !configured ? <button onClick={setup}>{t("setupCookies")}</button> : <button disabled={busy} onClick={sync}>{busy ? t("syncingCookies") : t("resyncCookies")}</button>}
      {!runtime && <button onClick={setup}>{t("cookieSettings")}</button>}
      {item.cookiesRefreshed && !overridden && configured && cookiesMatch(status, settings.firefoxProfile) && <button className="retry-prominent" disabled={busy} onClick={retry}>{t("retryDownload")}</button>}
      <button onClick={logs}>{t("viewLogs")}</button>
    </div>
    {item.recoveryError && <small className="warning-text" role="alert">{item.recoveryError}</small>}
  </div>;
}
