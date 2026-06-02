import { load } from "@tauri-apps/plugin-store";
import type { AdvancedValue, AppSettings } from "./types";

const SETTINGS_KEY = "settings";
const SENSITIVE_FLAGS = new Set([
  "--password",
  "--twofactor",
  "--video-password",
  "--ap-password",
  "--client-certificate-password",
  "--username",
  "--ap-username",
]);

export const DEFAULT_SETTINGS: AppSettings = {
  language: "en",
  destination: "",
  ffmpegDirectory: "",
  advancedModeAcknowledged: false,
  advancedValues: [],
};

export function safeAdvancedValues(values: AdvancedValue[]): AdvancedValue[] {
  return values.filter((value) => !SENSITIVE_FLAGS.has(value.flag));
}

export async function loadSettings(): Promise<AppSettings> {
  const store = await load("settings.json", { autoSave: false, defaults: {} });
  const saved = await store.get<Partial<AppSettings>>(SETTINGS_KEY);
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    advancedValues: safeAdvancedValues(saved?.advancedValues ?? []),
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const store = await load("settings.json", { autoSave: false, defaults: {} });
  await store.set(SETTINGS_KEY, {
    ...settings,
    advancedValues: safeAdvancedValues(settings.advancedValues),
  });
  await store.save();
}
