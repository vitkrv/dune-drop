export type Language = "en" | "uk";
export type Preset = "video" | "mp3";
export type Tab = "main" | "queue" | "advanced" | "logs" | "settings";
export type QueueStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface CatalogOption {
  flags: string[];
  argument?: string;
  description: string;
  dangerous: boolean;
  sensitive: boolean;
}

export interface CatalogSection {
  name: string;
  options: CatalogOption[];
}

export interface ToolInfo {
  deno: { path?: string; version?: string; available: boolean };
  version: string;
  executablePath: string;
  toolsDirectory: string;
  ffmpegDirectory?: string;
  ffmpegAvailable: boolean;
  catalog: CatalogSection[];
}

export interface AdvancedValue {
  flag: string;
  value: string;
}

export interface AppSettings {
  cookiesEnabled: boolean;
  firefoxProfile: string;
  language: Language;
  destination: string;
  ffmpegDirectory: string;
  advancedModeAcknowledged: boolean;
  advancedValues: AdvancedValue[];
}

export interface QueueItem {
  recoveryReason?: RecoveryReason;
  cookiesRefreshed?: boolean;
  recoveryError?: string;
  id: string;
  url: string;
  destination: string;
  preset: Preset;
  status: QueueStatus;
  error?: string;
  savedPaths?: string[];
}

export interface DownloadRequest {
  cookiesEnabled: boolean;
  firefoxProfile: string;
  jobId: string;
  urls: string[];
  destination: string;
  preset: Preset;
  ffmpegDirectory?: string;
  advancedArgs: string[];
  rawArgs: string;
  allowDangerousOptions: boolean;
}

export interface DownloadLogEvent {
  jobId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface DownloadDoneEvent {
  recoveryReason?: RecoveryReason;
  jobId: string;
  success: boolean;
  cancelled: boolean;
  exitCode?: number;
  error?: string;
  savedPaths?: string[];
}

export interface UtilityResponse {
  stdout: string;
  stderr: string;
  success: boolean;
}

export type RecoveryReason = "authorization" | "accountAccess" | "cookiesMissing" | "runtimeUnsupported";
export interface FirefoxProfile { name: string; path: string }
export interface CookieStatus { profile?: string; syncedAt?: number }
