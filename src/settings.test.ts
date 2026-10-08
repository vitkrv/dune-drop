import { describe, expect, it, vi } from "vitest";
import { loadSettings, safeAdvancedValues, saveSettings } from "./settings";

const store = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn(async () => store) }));

describe("safeAdvancedValues", () => {
  it("migrates old settings with cookies disabled and persists only cookie metadata", async () => {
    store.get.mockResolvedValue({ language: "uk", destination: "Downloads", advancedValues: [] });
    const settings = await loadSettings();
    expect(settings.cookiesEnabled).toBe(false); expect(settings.firefoxProfile).toBe("");
    await saveSettings({ ...settings, cookiesEnabled: true, firefoxProfile: "Firefox profile" });
    expect(store.set).toHaveBeenCalledWith("settings", expect.objectContaining({ cookiesEnabled: true, firefoxProfile: "Firefox profile" }));
    expect(Object.keys(store.set.mock.calls[0][1])).not.toContain("cookies");
  });
  it("keeps ordinary settings and omits credentials", () => {
    expect(
      safeAdvancedValues([
        { flag: "--proxy", value: "http://localhost:8080" },
        { flag: "--password", value: "secret" },
        { flag: "--twofactor", value: "123456" },
      ]),
    ).toEqual([{ flag: "--proxy", value: "http://localhost:8080" }]);
  });
});
