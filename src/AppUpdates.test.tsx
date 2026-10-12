import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppUpdates, canApplyUpdate } from "./AppUpdates";
import { translator } from "./i18n";

describe("portable app updates", () => {
  it("requires every queue item to be cleared and maintenance to finish", () => {
    expect(canApplyUpdate(0, false, true)).toBe(true);
    expect(canApplyUpdate(1, false, true)).toBe(false);
    expect(canApplyUpdate(0, true, true)).toBe(false);
    expect(canApplyUpdate(0, false, false)).toBe(false);
  });
  it.each(["en", "uk"] as const)("renders localized manual-update guidance in %s", language => {
    const t = translator(language);
    const html = renderToStaticMarkup(<AppUpdates t={t} queueLength={0} maintenance={false} flushSettings={async () => {}} setApplying={() => {}} />);
    expect(html).toContain(t("appCheckUpdates"));
    expect(html).toContain(t("appUpdateQueue"));
    expect(html).toContain(t("appUpdateManual"));
  });
});
