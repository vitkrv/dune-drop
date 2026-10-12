import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, CircleAlert, Download, RefreshCw, RotateCcw, Save, X } from "lucide-react";
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
  const [checking, setChecking] = useState(false);
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
    <div className="app-update-header">
      <div>
        <h2>{t("appUpdateTitle")}</h2>
        <p>{t("appInstalledVersion")}: <strong>{info?.currentVersion ?? "—"}</strong></p>
      </div>
      <button className="app-update-primary" disabled={busy} onClick={() => void action(async () => {
        setReady(false); setInfo(current => current ? { ...current, update: null } : current); setProgress(undefined);
        setChecking(true);
        try {
          const next = await invoke<AppUpdateInfo>("check_app_update"); setInfo(next);
          if (!next.update) setMessage("appUpdateCurrent");
        } finally { setChecking(false); }
      })}><RefreshCw size={18} aria-hidden="true" className={checking ? "app-update-spinner" : undefined} />{t(checking ? "appCheckingUpdates" : "appCheckUpdates")}</button>
    </div>
    {info?.recovery && <div className="app-update-result app-update-result-warning" role="alert"><CircleAlert size={22} aria-hidden="true" /><p>{t("appUpdateRolledBack")}</p></div>}
    {message && <div className={`app-update-result ${message === "appUpdateCurrent" || message === "appUpdateSaved" ? "app-update-result-success" : message === "appUpdateCancelled" || message === "appUpdateBusy" || message === "appUpdateQueue" ? "app-update-result-warning" : "app-update-result-error"}`} role="status" aria-live="polite">
      {message === "appUpdateCurrent" || message === "appUpdateSaved" ? <CheckCircle2 size={24} aria-hidden="true" /> : <CircleAlert size={24} aria-hidden="true" />}
      <p>{t(message)}</p>
    </div>}
    {info?.update && <div className="app-update-release">
      <div className="app-update-available" role="status"><Download size={24} aria-hidden="true" /><strong>{t("appUpdateAvailable")}: {info.update.version}</strong></div>
      <pre className="app-release-notes">{info.update.notes}</pre>
      <div className="tool-actions app-update-actions">
        {!ready && <button className="app-update-primary" disabled={busy} onClick={() => void action(async () => {
          setDownloading(true); setProgress(undefined);
          await invoke("download_app_update"); setReady(true);
        })}><Download size={17} aria-hidden="true" />{t("appDownloadUpdate")}</button>}
        {downloading && <button onClick={() => void invoke("cancel_app_update").catch(() => setMessage("appUpdateIo"))}><X size={17} aria-hidden="true" />{t("appCancelUpdate")}</button>}
        {ready && <>
          <button className="app-update-primary" disabled={busy || !canApplyUpdate(queueLength, maintenance, ready)} onClick={() => void action(async () => {
            if (!canApplyUpdate(queueLength, maintenance, ready)) throw "appUpdateQueue";
            setApplying(true);
            try { await flushSettings(); await invoke("apply_app_update", { queueEmpty: queueLength === 0 }); }
            finally { setApplying(false); }
          })}><RotateCcw size={17} aria-hidden="true" />{t("appApplyUpdate")}</button>
          <button disabled={busy} onClick={() => void action(async () => {
            const destination = await save({ defaultPath: `DuneDrop-${info.update!.version}.exe`, filters: [{ name: "DuneDrop", extensions: ["exe"] }] });
            if (destination) { await invoke("save_app_update", { destination }); setMessage("appUpdateSaved"); }
          })}><Save size={17} aria-hidden="true" />{t("appSaveUpdate")}</button>
        </>}
      </div>
      {progress && <progress aria-label={t("appDownloadUpdate")} value={progress.downloaded} max={progress.total} />}
    </div>}
    <div className="app-update-guidance"><p>{t("appUpdateQueue")}</p><p>{t("appUpdateManual")}</p></div>
  </section>;
}
