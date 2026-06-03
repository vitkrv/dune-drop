import { useCallback, useEffect, useMemo, useState } from "react";
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
import { translator } from "./i18n";
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

export default function App() {
  const [tab, setTab] = useState<Tab>("main");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [toolInfo, setToolInfo] = useState<ToolInfo>();
  const [urls, setUrls] = useState("");
  const [preset, setPreset] = useState<Preset>("video");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [runningId, setRunningId] = useState<string>();
  const [logs, setLogs] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [rawArgs, setRawArgs] = useState("");
  const [preview, setPreview] = useState<string[]>([]);
  const [showWarning, setShowWarning] = useState(false);
  const t = useMemo(() => translator(settings.language), [settings.language]);

  const refreshToolInfo = useCallback(async () => {
    const info = await invoke<ToolInfo>("initialize", {
      ffmpegDirectory: settings.ffmpegDirectory || null,
    });
    setToolInfo(info);
  }, [settings.ffmpegDirectory]);

  useEffect(() => {
    void loadSettings().then((loaded) => {
      setSettings(loaded);
      setSettingsLoaded(true);
    });
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void refreshToolInfo().catch((error) => setNotice(String(error)));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [refreshToolInfo]);

  useEffect(() => {
    if (settingsLoaded) void saveSettings(settings).catch((error) => setNotice(String(error)));
  }, [settings, settingsLoaded]);

  useEffect(() => {
    let unlistenLog: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    void listen<DownloadLogEvent>("download-log", ({ payload }) => {
      setLogs((current) => current + payload.chunk);
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
  }, []);

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
    }),
    [rawArgs, selectedArgs, settings.advancedModeAcknowledged, settings.destination, settings.ffmpegDirectory],
  );

  useEffect(() => {
    if (runningId) return;
    const next = queue.find((item) => item.status === "pending");
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
        items.map((item) => (item.id === next.id ? { ...item, status: "failed", error: String(error) } : item)),
      );
    });
  }, [queue, requestFor, runningId, t]);

  useEffect(() => {
    const sample: QueueItem = { id: "preview", url: "URL", destination: settings.destination, preset, status: "pending" };
    void invoke<string[]>("preview_download_args", { request: requestFor(sample) })
      .then(setPreview)
      .catch(() => setPreview([]));
  }, [preset, requestFor, settings.destination]);

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
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
      ...items,
      ...submittedUrls.map((url): QueueItem => ({
        id: makeId(),
        url,
        destination: settings.destination,
        preset,
        status: "pending",
      })),
    ]);
    setUrls("");
    setNotice("");
    setTab("queue");
  }

  async function cancelActive() {
    await invoke("cancel_download");
  }

  function retry(item: QueueItem) {
    setQueue((items) => [...items, { ...item, id: makeId(), status: "pending", error: undefined }]);
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
      setLogs((current) => current + result.stdout + result.stderr);
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
      setLogs((current) => current + result.stdout + result.stderr);
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
      </aside>

      <section className="workspace">
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
                      <strong>{item.url}</strong>
                      <small>
                        {item.preset.toUpperCase()} · {statusLabel(item.status, t)}
                        {item.error ? ` · ${item.error}` : ""}
                      </small>
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
          <div className="content">
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
                  <button onClick={() => setLogs("")}>
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
