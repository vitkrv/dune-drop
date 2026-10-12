import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { translator, TranslationKey } from "./i18n";
import type { AppUpdateInfo, AppUpdateProgress } from "./types";

export function canApplyUpdate(queueLength: number, maintenance: boolean, ready: boolean) {
  return queueLength === 0 && !maintenance && ready;
}

export function AppUpdates({ t, queueLength, maintenance, flushSettings, setApplying }: {
  t: ReturnType<typeof translator>; queueLength: number; maintenance: boolean;
  flushSettings: () => Promise<void>; setApplying: (busy: boolean) => void;
}) {
  const [info, setInfo] = useState<AppUpdateInfo>();
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState<TranslationKey>();
  const [progress, setProgress] = useState<AppUpdateProgress>();
  const operation = useRef(false);
  useEffect(() => {
    void invoke<AppUpdateInfo>("app_update_info").then(setInfo).catch(() => setMessage("appUpdateIo"));
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AppUpdateProgress>("app-update-progress", e => setProgress(e.payload))
      .then(fn => { if (disposed) fn(); else unlisten = fn; })
      .catch(() => setMessage("appUpdateIo"));
    return () => { disposed = true; unlisten?.(); };
  }, []);

  async function action(run: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setMessage(undefined);
    try { await run(); }
    catch (error) {
      const key = String(error);
      const known: TranslationKey[] = ["appUpdateIo", "appUpdateBusy", "appUpdateUnconfigured", "appUpdateInvalid", "appUpdateSignature", "appUpdateNetwork", "appUpdateIntegrity", "appUpdateCancelled", "appUpdateCheckFirst", "appUpdateRecovery", "appUpdateDisk", "appUpdateUnwritable", "appUpdateQueue"];
      setMessage(known.includes(key as TranslationKey) ? key as TranslationKey : "appUpdateIo");
    } finally { operation.current = false; setBusy(false); setDownloading(false); }
  }
  return <section className="card tool-card app-updates">
    <h2>{t("appUpdateTitle")}</h2>
    <p>{t("appInstalledVersion")}: {info?.currentVersion ?? "—"}</p>
    {info?.recovery && <p role="alert">{t("appUpdateRolledBack")}</p>}
    <button disabled={busy} onClick={() => void action(async () => {
      setReady(false); setInfo(current => current ? { ...current, update: null } : current); setProgress(undefined);
      const next = await invoke<AppUpdateInfo>("check_app_update"); setInfo(next);
      if (!next.update) setMessage("appUpdateCurrent");
    })}>{t("appCheckUpdates")}</button>
    {info?.update && <>
      <p>{t("appUpdateAvailable")}: {info.update.version}</p>
      <pre className="app-release-notes">{info.update.notes}</pre>
      {!ready && <button disabled={busy} onClick={() => void action(async () => {
        setDownloading(true); setProgress(undefined);
        await invoke("download_app_update"); setReady(true);
      })}>{t("appDownloadUpdate")}</button>}
      {downloading && <button onClick={() => void invoke("cancel_app_update").catch(() => setMessage("appUpdateIo"))}>{t("appCancelUpdate")}</button>}
      {progress && <progress aria-label={t("appDownloadUpdate")} value={progress.downloaded} max={progress.total} />}
      {ready && <div className="tool-actions">
        <button disabled={busy || !canApplyUpdate(queueLength, maintenance, ready)} onClick={() => void action(async () => {
          if (!canApplyUpdate(queueLength, maintenance, ready)) throw "appUpdateQueue";
          setApplying(true);
          try { await flushSettings(); await invoke("apply_app_update", { queueEmpty: queueLength === 0 }); }
          finally { setApplying(false); }
        })}>{t("appApplyUpdate")}</button>
        <button disabled={busy} onClick={() => void action(async () => {
          const destination = await save({ defaultPath: `DuneDrop-${info.update!.version}.exe`, filters: [{ name: "DuneDrop", extensions: ["exe"] }] });
          if (destination) { await invoke("save_app_update", { destination }); setMessage("appUpdateSaved"); }
        })}>{t("appSaveUpdate")}</button>
      </div>}
    </>}
    <p>{t("appUpdateQueue")}</p>
    <p>{t("appUpdateManual")}</p>
    {message && <p role="status">{t(message)}</p>}
  </section>;
}
