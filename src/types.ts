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
  language: Language;
  destination: string;
  ffmpegDirectory: string;
  advancedModeAcknowledged: boolean;
  advancedValues: AdvancedValue[];
}

export interface QueueItem {
  id: string;
  url: string;
  preset: Preset;
  status: QueueStatus;
  error?: string;
}

export interface DownloadRequest {
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
  jobId: string;
  success: boolean;
  cancelled: boolean;
  exitCode?: number;
  error?: string;
}

export interface UtilityResponse {
  stdout: string;
  stderr: string;
  success: boolean;
}

