import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  BookOpen,
  Check,
  ChevronRight,
  Clipboard,
  Download,
  FileAudio,
  FileVideo,
  FolderOpen,
  ListVideo,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { translator, type TranslationKey } from "./i18n";
import { CookieControls, CookieContext, RecoveryPanel } from "./CookieControls";
import { hasCookieOverride, markCookiesRefreshed } from "./recovery";
import { appendTerminalLogChunk, EMPTY_LOG_STATE, type LogState } from "./logs";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";
import type {
  AdvancedValue,
  AppSettings,
  CatalogOption,
  DownloadDoneEvent,
  DownloadLogEvent,
  DownloadRequest,
  Preset,
  QueueItem,
  QueueStatus,
  Tab,
  ToolInfo,
  UtilityResponse,
  CookieStatus,
  FirefoxProfile,
} from "./types";

const DOCS_URL = "https://github.com/yt-dlp/yt-dlp#usage-and-options";

function makeId(): string {
  return crypto.randomUUID();
}

function optionLabel(option: CatalogOption): string {
  return option.flags.find((flag) => flag.startsWith("--")) ?? option.flags[0];
}

function statusLabel(status: QueueStatus, t: ReturnType<typeof translator>): string {
  const labels = {
    pending: t("waiting"),
    running: t("activeDownload"),
    completed: t("completed"),
    failed: t("failed"),
    cancelled: t("cancelled"),
  };
  return labels[status];
}

function splitUrls(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((url) => url.trim())
    .filter(Boolean);
}

function advancedArgs(values: AdvancedValue[]): string[] {
  return values.flatMap(({ flag, value }) => (value.trim() ? [flag, value.trim()] : [flag]));
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function oldestPending(items: QueueItem[]): QueueItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].status === "pending") return items[index];
  }
  return undefined;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("main");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [starting, setStarting] = useState(true);
  const [profiles, setProfiles] = useState<FirefoxProfile[]>([]);
  const [cookieStatus, setCookieStatus] = useState<CookieStatus>({});
  const [cookieBusy, setCookieBusy] = useState(false);
  const cookieBusyRef = useRef(false);
  const [cookieError, setCookieError] = useState("");
  const [cookieFocus, setCookieFocus] = useState(0);
  const [denoBusy, setDenoBusy] = useState(false);
  const [toolRevision, setToolRevision] = useState(0);
  const initializedFfmpegDirectory = useRef<string>();
  const [toolInfo, setToolInfo] = useState<ToolInfo>();
  const [urls, setUrls] = useState("");
  const [preset, setPreset] = useState<Preset>("video");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [runningId, setRunningId] = useState<string>();
  const [logs, setLogs] = useState("");
  const logState = useRef<LogState>(EMPTY_LOG_STATE);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [rawArgs, setRawArgs] = useState("");
  const [preview, setPreview] = useState<string[]>([]);
  const [showWarning, setShowWarning] = useState(false);
  const t = useMemo(() => translator(settings.language), [settings.language]);
  const errorText = useCallback((error: unknown) => {
    const code = String(error);
    return /^(cookie_(profile_missing|extract_failed|invalid_export|no_youtube|sync_required|sync_busy|storage_failed)|deno_install_busy|deno_refresh_failed)$/.test(code) ? t(code as TranslationKey) : code;
  }, [t]);

  const appendLogs = useCallback((chunk: string) => {
    setLogs(() => {
      const next = appendTerminalLogChunk(logState.current, chunk);
      logState.current = next;
      return next.text;
    });
  }, []);

  const clearLogs = useCallback(() => {
    logState.current = EMPTY_LOG_STATE;
    setLogs("");
  }, []);

  const refreshToolInfo = useCallback(async () => {
    const info = await invoke<ToolInfo>("initialize", {
      ffmpegDirectory: settings.ffmpegDirectory || null,
    });
    setToolInfo(info);
    setToolRevision(value => value + 1);
  }, [settings.ffmpegDirectory]);

  useEffect(() => {
    void Promise.all([invoke<FirefoxProfile[]>("firefox_profiles"), invoke<CookieStatus>("cookie_status")])
      .then(([found, status]) => { setProfiles(found); setCookieStatus(status); })
      .catch(error => setCookieError(String(error)));
  }, []);

  useEffect(() => {
    if (settingsLoaded && !settings.firefoxProfile && profiles.length === 1) {
      setSettings(current => ({ ...current, firefoxProfile: profiles[0].path }));
    }
  }, [profiles, settingsLoaded, settings.firefoxProfile]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        let loaded = DEFAULT_SETTINGS;
        let loadedSuccessfully = false;
        try {
          loaded = await loadSettings();
          loadedSuccessfully = true;
        } catch (error) {
          if (active) setNotice(String(error));
        }
        if (!active) return;
        setSettings(loaded);
        setSettingsLoaded(loadedSuccessfully);
        initializedFfmpegDirectory.current = loaded.ffmpegDirectory;
        const info = await invoke<ToolInfo>("initialize", {
          ffmpegDirectory: loaded.ffmpegDirectory || null,
        });
        if (active) setToolInfo(info);
      } catch (error) {
        if (active) setNotice(String(error));
      } finally {
        if (active) setStarting(false);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (starting || settings.ffmpegDirectory === initializedFfmpegDirectory.current) return;
    const timeout = window.setTimeout(() => {
      initializedFfmpegDirectory.current = settings.ffmpegDirectory;
      void refreshToolInfo().catch((error) => setNotice(String(error)));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [refreshToolInfo, settings.ffmpegDirectory, starting]);

  useEffect(() => {
    if (settingsLoaded) void saveSettings(settings).catch((error) => setNotice(String(error)));
  }, [settings, settingsLoaded]);

  useEffect(() => {
    let unlistenLog: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    void listen<DownloadLogEvent>("download-log", ({ payload }) => {
      appendLogs(payload.chunk);
    }).then((unlisten) => {
      unlistenLog = unlisten;
    });
    void listen<DownloadDoneEvent>("download-done", ({ payload }) => {
      setQueue((items) =>
        items.map((item) =>
          item.id === payload.jobId
            ? {
                ...item,
                status: payload.cancelled ? "cancelled" : payload.success ? "completed" : "failed",
                error: payload.error,
                savedPaths: payload.savedPaths,
                recoveryReason: payload.recoveryReason,
              }
            : item,
        ),
      );
      setRunningId((current) => (current === payload.jobId ? undefined : current));
    }).then((unlisten) => {
      unlistenDone = unlisten;
    });
    return () => {
      unlistenLog?.();
      unlistenDone?.();
    };
  }, [appendLogs]);

  const selectedArgs = useMemo(() => advancedArgs(settings.advancedValues), [settings.advancedValues]);

  const requestFor = useCallback(
    (item: QueueItem): DownloadRequest => ({
      jobId: item.id,
      urls: [item.url],
      destination: item.destination || settings.destination,
      preset: item.preset,
      ffmpegDirectory: settings.ffmpegDirectory || undefined,
      advancedArgs: selectedArgs,
      rawArgs,
      allowDangerousOptions: settings.advancedModeAcknowledged,
      cookiesEnabled: settings.cookiesEnabled,
      firefoxProfile: settings.firefoxProfile,
    }),
    [rawArgs, selectedArgs, settings.advancedModeAcknowledged, settings.destination, settings.ffmpegDirectory, settings.cookiesEnabled, settings.firefoxProfile],
  );

  useEffect(() => {
    if (runningId || denoBusy) return;
    const next = oldestPending(queue);
    if (!next) return;
    if (!next.destination) {
      setNotice(t("missingDestination"));
      return;
    }
    setRunningId(next.id);
    setQueue((items) => items.map((item) => (item.id === next.id ? { ...item, status: "running" } : item)));
    void invoke("start_download", { request: requestFor(next) }).catch((error) => {
      setRunningId(undefined);
      setQueue((items) =>
        items.map((item) => (item.id === next.id ? { ...item, status: "failed", error: errorText(error), recoveryReason: String(error) === "cookie_sync_required" ? "cookiesMissing" : undefined } : item)),
      );
    });
  }, [queue, requestFor, runningId, t, denoBusy, errorText]);

  useEffect(() => {
    const sample: QueueItem = { id: "preview", url: splitUrls(urls)[0] || "https://www.youtube.com/watch?v=VIDEO_ID", destination: settings.destination, preset, status: "pending" };
    void invoke<string[]>("preview_download_args", { request: requestFor(sample) })
      .then(setPreview)
      .catch(() => setPreview([]));
  }, [preset, requestFor, settings.destination, toolRevision, urls]);

  function updateSettings(patch: Partial<AppSettings>) {
    if (patch.firefoxProfile !== undefined || patch.cookiesEnabled !== undefined) {
      setQueue(items => items.map(item => ({ ...item, cookiesRefreshed: false, recoveryError: undefined })));
      setCookieError("");
    }
    setSettings((current) => ({ ...current, ...patch }));
  }

  function showCookieSettings() { setCookieFocus(value => value + 1); setTab("settings"); }

  async function syncCookies() {
    if (cookieBusyRef.current) return;
    if (!settings.firefoxProfile) { showCookieSettings(); return; }
    cookieBusyRef.current = true;
    setCookieBusy(true); setCookieError("");
    try {
      const status = await invoke<CookieStatus>("sync_cookies", { profile: settings.firefoxProfile });
      setCookieStatus(status);
      setQueue(markCookiesRefreshed);
    } catch (error) {
      const message = errorText(error);
      setCookieError(message);
      setQueue(items => items.map(item => item.status === "failed" && item.recoveryReason ? { ...item, recoveryError: message, cookiesRefreshed: false } : item));
    } finally { cookieBusyRef.current = false; setCookieBusy(false); }
  }

  async function clearCookies() {
    if (cookieBusyRef.current) return;
    cookieBusyRef.current = true; setCookieBusy(true); setCookieError("");
    try {
      setCookieStatus(await invoke<CookieStatus>("clear_cookies"));
      setQueue(items => items.map(item => ({ ...item, cookiesRefreshed: false })));
    } catch (error) { setCookieError(errorText(error)); }
    finally { cookieBusyRef.current = false; setCookieBusy(false); }
  }

  async function browseFirefoxProfile() {
    const path = await open({ directory: true, multiple: false, title: t("firefoxProfile") });
    if (typeof path === "string") updateSettings({ firefoxProfile: path });
  }

  async function installDeno() {
    if (denoBusy || runningId) return;
    setDenoBusy(true);
    try {
      const result = await invoke<UtilityResponse>("install_deno");
      await refreshToolInfo();
      setNotice(result.success ? t("denoInstalled") : t("denoInstallFailed"));
      if (!result.success) setTab("logs");
    } catch (error) { setNotice(errorText(error)); }
    finally { setDenoBusy(false); }
  }

  async function pickDestination() {
    const selected = await open({ directory: true, multiple: false, title: t("pickFolder") });
    if (typeof selected === "string") updateSettings({ destination: selected });
  }

  async function pickFfmpegFolder() {
    const selected = await open({ directory: true, multiple: false, title: t("ffmpegFolder") });
    if (typeof selected === "string") updateSettings({ ffmpegDirectory: selected });
  }

  function enqueue() {
    const submittedUrls = splitUrls(urls);
    if (!settings.destination) return setNotice(t("missingDestination"));
    if (!submittedUrls.length) return setNotice(t("missingUrl"));
    if (preset === "mp3" && !toolInfo?.ffmpegAvailable) return setNotice(t("ffmpegNeeded"));
    setQueue((items) => [
      ...[...submittedUrls].reverse().map((url): QueueItem => ({
        id: makeId(),
        url,
        destination: settings.destination,
        preset,
        status: "pending",
      })),
      ...items,
    ]);
    setUrls("");
    setNotice("");
    setTab("queue");
  }

  async function cancelActive() {
    await invoke("cancel_download");
  }

  function retry(item: QueueItem) {
    setQueue((items) => [{ ...item, id: makeId(), status: "pending", error: undefined, savedPaths: undefined, recoveryReason: undefined, cookiesRefreshed: false, recoveryError: undefined }, ...items]);
  }

  function removeItem(id: string) {
    setQueue((items) => items.filter((item) => item.id !== id || item.status === "running"));
  }

  async function revealItemFolder(item: QueueItem) {
    try {
      await invoke("reveal_download_folder", { path: item.destination });
    } catch (error) {
      setNotice(String(error));
    }
  }

  function toggleAdvanced(option: CatalogOption) {
    const flag = optionLabel(option);
    const existing = settings.advancedValues.find((value) => value.flag === flag);
    const next = existing
      ? settings.advancedValues.filter((value) => value.flag !== flag)
      : [...settings.advancedValues, { flag, value: "" }];
    updateSettings({ advancedValues: next });
  }

  function setAdvancedValue(flag: string, value: string) {
    updateSettings({
      advancedValues: settings.advancedValues.map((entry) => (entry.flag === flag ? { ...entry, value } : entry)),
    });
  }

  async function saveLogs() {
    const path = await save({ defaultPath: "dunedrop.log", filters: [{ name: "Log file", extensions: ["log", "txt"] }] });
    if (path) await invoke("write_log_file", { path, contents: logs });
  }

  async function replaceTool() {
    const path = await open({ multiple: false, filters: [{ name: "yt-dlp executable", extensions: ["exe"] }] });
    if (typeof path !== "string") return;
    const info = await invoke<ToolInfo>("replace_ytdlp", {
      sourcePath: path,
      ffmpegDirectory: settings.ffmpegDirectory || null,
    });
    setToolInfo(info);
  }

  async function updateTool() {
    try {
      const result = await invoke<UtilityResponse>("update_ytdlp");
      appendLogs(result.stdout + result.stderr);
      await refreshToolInfo();
      setTab("logs");
    } catch (error) {
      setNotice(`${t("toolActionFailed")}: ${String(error)}`);
    }
  }

  async function runUtility() {
    try {
      const result = await invoke<UtilityResponse>("run_utility", {
        rawArgs,
        allowDangerousOptions: settings.advancedModeAcknowledged,
      });
      appendLogs(result.stdout + result.stderr);
      setTab("logs");
    } catch (error) {
      setNotice(`${t("toolActionFailed")}: ${String(error)}`);
    }
  }

  const options = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (
      toolInfo?.catalog
        .flatMap((section) => section.options.map((option) => ({ section: section.name, option })))
        .filter(({ section, option }) => {
          const haystack = `${section} ${option.flags.join(" ")} ${option.argument ?? ""} ${option.description}`.toLowerCase();
          return !term || haystack.includes(term);
        }) ?? []
    );
  }, [search, toolInfo?.catalog]);

  const nav: Array<{ id: Tab; icon: typeof Download }> = [
    { id: "main", icon: Download },
    { id: "queue", icon: ListVideo },
    { id: "advanced", icon: Wrench },
    { id: "logs", icon: Terminal },
    { id: "settings", icon: SettingsIcon },
  ];

  if (starting) {
    return (
      <main className="startup-screen" role="status" aria-live="polite">
        <div className="startup-content">
          <img className="startup-mark" src="/dunedrop-icon.png" alt="" />
          <h1>DuneDrop</h1>
          <p>{t("starting")}</p>
          <span className="startup-spinner" aria-hidden="true" />
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/dunedrop-icon.png" alt="" />
          <div>
            <strong>DuneDrop</strong>
            <span>Media downloader</span>
          </div>
        </div>
        <nav>
          {nav.map(({ id, icon: Icon }) => (
            <button className={tab === id ? "nav-button active" : "nav-button"} key={id} onClick={() => setTab(id)}>
              <Icon size={17} />
              {t(id)}
              {id === "queue" && queue.length > 0 && <b>{queue.length}</b>}
            </button>
          ))}
        </nav>
        <button className="docs-link" onClick={() => void openUrl(DOCS_URL)}>
          <BookOpen size={16} />
          {t("help")}
        </button>
        <div className="app-build-info">
          <span>{t("appVersion")} {__APP_VERSION__}</span>
          <span>{t("buildDate")} <time dateTime={__BUILD_DATE__}>{__BUILD_DATE__}</time></span>
        </div>
      </aside>

      <section className={tab === "logs" ? "workspace logs-workspace" : "workspace"}>
        <header className="topbar">
          <div>
            <h1>{t(tab)}</h1>
            <p>{t("tagline")}</p>
          </div>
          <span className={runningId ? "status running" : "status"}>
            <i />
            {runningId ? t("statusRunning") : t("statusReady")}
          </span>
        </header>
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button onClick={() => setNotice("")}>
              <X size={15} />
            </button>
          </div>
        )}

        {tab === "main" && (
          <div className="content main-grid">
            <section className="card hero-card">
              <div className="section-kicker">01 / SOURCE</div>
              <label>{t("urls")}</label>
              <textarea
                className="url-input"
                value={urls}
                onChange={(event) => setUrls(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                autoFocus
              />
              <small>{t("urlsHint")}</small>
              <div className="tool-actions">
                <button disabled={cookieBusy} onClick={() => settings.cookiesEnabled && settings.firefoxProfile ? void syncCookies() : showCookieSettings()}><RefreshCw size={15} />{cookieBusy ? t("syncingCookies") : t("resyncCookies")}</button>
                <button onClick={showCookieSettings}>{t("cookieSettings")}</button>
              </div>
              <CookieContext status={cookieStatus} profile={settings.firefoxProfile} t={t} />
              {cookieError && <small role="alert" className="warning-text">{cookieError}</small>}
            </section>

            <section className="card">
              <div className="section-kicker">02 / DESTINATION</div>
              <label>{t("destination")}</label>
              <button className="folder-picker" onClick={() => void pickDestination()}>
                <FolderOpen size={18} />
                <span>{settings.destination || t("pickFolder")}</span>
                <ChevronRight size={17} />
              </button>
            </section>

            <section className="card">
              <div className="section-kicker">03 / FORMAT</div>
              <div className="preset-grid">
                <button className={preset === "video" ? "preset active" : "preset"} onClick={() => setPreset("video")}>
                  <FileVideo />
                  <strong>{t("video")}</strong>
                  <span>{t("videoHint")}</span>
                </button>
                <button
                  className={preset === "mp3" ? "preset active" : "preset"}
                  onClick={() => setPreset("mp3")}
                  disabled={!toolInfo?.ffmpegAvailable}
                  title={!toolInfo?.ffmpegAvailable ? t("ffmpegNeeded") : undefined}
                >
                  <FileAudio />
                  <strong>{t("mp3")}</strong>
                  <span>{t("mp3Hint")}</span>
                </button>
              </div>
              {!toolInfo?.ffmpegAvailable && <small className="warning-text">{t("ffmpegNeeded")}</small>}
            </section>

            <button className="primary-action" onClick={enqueue}>
              <Download size={19} />
              {t("addQueue")}
            </button>
          </div>
        )}

        {tab === "queue" && (
          <div className="content">
            <section className="card">
              <div className="card-title">
                <div>
                  <div className="section-kicker">DOWNLOADS</div>
                  <h2>{t("queue")}</h2>
                </div>
                {runningId && (
                  <button className="danger-button" onClick={() => void cancelActive()}>
                    <Square size={14} /> {t("cancel")}
                  </button>
                )}
              </div>
              {!queue.length && <div className="empty-state">{t("emptyQueue")}</div>}
              <div className="queue-list">
                {queue.map((item) => (
                  <article className="queue-item" key={item.id}>
                    <span className={`queue-dot ${item.status}`} />
                    <div>
                      <strong>{item.savedPaths?.map(fileNameFromPath).join(", ") || item.url}</strong>
                      <small>
                        {item.preset.toUpperCase()} · {statusLabel(item.status, t)}
                        {item.savedPaths?.length ? ` · ${item.url}` : ""}
                        {item.error ? ` · ${item.error}` : ""}
                      </small>
                      <RecoveryPanel item={item} settings={settings} status={cookieStatus} busy={cookieBusy}
                        overridden={hasCookieOverride(selectedArgs, rawArgs)} t={t}
                        sync={() => void syncCookies()} setup={showCookieSettings} logs={() => setTab("logs")}
                        advanced={() => setTab("advanced")} retry={() => retry(item)} updateTool={() => void updateTool()} />
                    </div>
                    <div className="queue-actions">
                      {item.status === "completed" && (
                        <button onClick={() => void revealItemFolder(item)} title={t("openFolder")}>
                          <FolderOpen size={15} />
                        </button>
                      )}
                      {["failed", "cancelled"].includes(item.status) && (
                        <button onClick={() => retry(item)} title={t("retry")}>
                          <RotateCcw size={15} />
                        </button>
                      )}
                      {item.status !== "running" && (
                        <button onClick={() => removeItem(item.id)} title={t("remove")}>
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}

        {tab === "advanced" && (
          <div className="content advanced-layout">
            {!settings.advancedModeAcknowledged ? (
              <section className="card warning-card">
                <ShieldAlert size={34} />
                <h2>{t("advancedWarningTitle")}</h2>
                <p>{t("advancedWarning")}</p>
                {!showWarning ? (
                  <button className="secondary-action" onClick={() => setShowWarning(true)}>
                    {t("enableAdvanced")}
                  </button>
                ) : (
                  <div className="warning-actions">
                    <button className="primary-inline" onClick={() => updateSettings({ advancedModeAcknowledged: true })}>
                      <Check size={16} /> {t("acknowledge")}
                    </button>
                    <button className="ghost-button" onClick={() => setShowWarning(false)}>
                      {t("back")}
                    </button>
                  </div>
                )}
              </section>
            ) : (
              <>
                <section className="card catalog-card">
                  <div className="card-title">
                    <div>
                      <div className="section-kicker">CURRENT --HELP</div>
                      <h2>{t("catalog")}</h2>
                    </div>
                    <button className="icon-text" onClick={() => void refreshToolInfo()}>
                      <RefreshCw size={15} /> {t("refresh")}
                    </button>
                  </div>
                  <p>{t("catalogHint")}</p>
                  <label className="search-box">
                    <Search size={16} />
                    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("search")} />
                  </label>
                  <div className="option-list">
                    {!options.length && <div className="empty-state">{t("noOptions")}</div>}
                    {options.map(({ section, option }) => {
                      const flag = optionLabel(option);
                      const selected = settings.advancedValues.some((entry) => entry.flag === flag);
                      return (
                        <article className="option-row" key={`${section}-${flag}`}>
                          <div>
                            <small>{section}</small>
                            <strong>
                              {option.flags.join(", ")} {option.argument}
                              {option.dangerous && <em>{t("dangerous")}</em>}
                            </strong>
                            <p>{option.description}</p>
                          </div>
                          <button className={selected ? "small-button selected" : "small-button"} onClick={() => toggleAdvanced(option)}>
                            {selected ? <Check size={14} /> : <Play size={13} />} {selected ? t("remove") : t("add")}
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </section>
                <section className="advanced-side">
                  <div className="card">
                    <div className="section-kicker">ARGS</div>
                    <h2>{t("activeOptions")}</h2>
                    {!settings.advancedValues.length && <div className="empty-state">--</div>}
                    {settings.advancedValues.map((entry) => (
                      <div className="active-option" key={entry.flag}>
                        <code>{entry.flag}</code>
                        <input
                          value={entry.value}
                          onChange={(event) => setAdvancedValue(entry.flag, event.target.value)}
                          placeholder={t("optionValue")}
                        />
                      </div>
                    ))}
                    <label>{t("rawArgs")}</label>
                    <textarea className="raw-input" value={rawArgs} onChange={(event) => setRawArgs(event.target.value)} />
                    <small>{t("rawArgsHint")}</small>
                    <button className="secondary-action utility-button" onClick={() => void runUtility()}>
                      <Terminal size={15} /> {t("runUtility")}
                    </button>
                    <small>{t("utilityHint")}</small>
                  </div>
                  <div className="card preview-card">
                    <div className="section-kicker">{t("preview")}</div>
                    <code>yt-dlp.exe {preview.map((arg) => JSON.stringify(arg)).join(" ")}</code>
                  </div>
                </section>
              </>
            )}
          </div>
        )}

        {tab === "logs" && (
          <div className="content logs-content">
            <section className="card log-card">
              <div className="card-title">
                <div>
                  <div className="section-kicker">STDOUT + STDERR</div>
                  <h2>{t("rawLogs")}</h2>
                </div>
                <div className="toolbar">
                  <button onClick={() => void navigator.clipboard.writeText(logs)}>
                    <Clipboard size={15} /> {t("copy")}
                  </button>
                  <button onClick={clearLogs}>
                    <Trash2 size={15} /> {t("clear")}
                  </button>
                  <button onClick={() => void saveLogs()}>
                    <Save size={15} /> {t("save")}
                  </button>
                </div>
              </div>
              <pre>{logs || t("noLogs")}</pre>
            </section>
          </div>
        )}

        {tab === "settings" && (
          <div className="content settings-grid">
            <CookieControls settings={settings} status={cookieStatus} profiles={profiles} busy={cookieBusy}
              error={cookieError} focus={cookieFocus} t={t} update={updateSettings}
              browse={() => void browseFirefoxProfile()} sync={() => void syncCookies()} clear={() => void clearCookies()} />
            <section className="card">
              <h2>{t("denoTitle")}</h2>
              <p>{t("denoHint")}</p>
              <dl><dt>{t("toolVersion")}</dt><dd>{toolInfo?.deno.version || "—"}</dd><dt>deno.exe</dt><dd>{toolInfo?.deno.path || "—"}</dd></dl>
              <div className={toolInfo?.deno.available ? "tool-health ok" : "tool-health"}><i />Deno {toolInfo?.deno.available ? t("available") : t("notFound")}</div>
              <div className="tool-actions"><button disabled={denoBusy || Boolean(runningId)} onClick={() => void installDeno()}>{denoBusy ? t("installingDeno") : t("installDeno")}</button><button onClick={() => setTab("logs")}>{t("viewLogs")}</button></div>
              {denoBusy && <small role="status">{t("installingDeno")}</small>}
            </section>
            <section className="card">
              <div className="section-kicker">APP</div>
              <h2>{t("language")}</h2>
              <div className="segmented">
                <button className={settings.language === "en" ? "active" : ""} onClick={() => updateSettings({ language: "en" })}>
                  {t("english")}
                </button>
                <button className={settings.language === "uk" ? "active" : ""} onClick={() => updateSettings({ language: "uk" })}>
                  {t("ukrainian")}
                </button>
              </div>
            </section>
            <section className="card">
              <div className="section-kicker">POST-PROCESSING</div>
              <h2>{t("ffmpegFolder")}</h2>
              <div className="field-row">
                <input
                  value={settings.ffmpegDirectory}
                  onChange={(event) => updateSettings({ ffmpegDirectory: event.target.value })}
                  placeholder="C:\\Tools\\ffmpeg\\bin"
                />
                <button className="small-button" onClick={() => void pickFfmpegFolder()}>
                  <FolderOpen size={15} /> {t("browse")}
                </button>
              </div>
              <small>{t("ffmpegHint")}</small>
              <div className={toolInfo?.ffmpegAvailable ? "tool-health ok" : "tool-health"}>
                <i /> ffmpeg + ffprobe {toolInfo?.ffmpegAvailable ? t("available") : t("notFound")}
              </div>
            </section>
            <section className="card tool-card">
              <div className="section-kicker">TOOLS</div>
              <h2>{t("tool")}</h2>
              <dl>
                <dt>{t("toolVersion")}</dt>
                <dd>{toolInfo?.version ?? "--"}</dd>
                <dt>yt-dlp.exe</dt>
                <dd>{toolInfo?.executablePath ?? "--"}</dd>
              </dl>
              <div className="tool-actions">
                <button onClick={() => void invoke("reveal_tools_folder")}>
                  <FolderOpen size={15} /> {t("revealTools")}
                </button>
                <button onClick={() => void replaceTool()}>
                  <RefreshCw size={15} /> {t("replaceTool")}
                </button>
                <button onClick={() => void updateTool()}>
                  <Download size={15} /> {t("updateTool")}
                </button>
              </div>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
