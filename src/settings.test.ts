import { describe, expect, it } from "vitest";
import { safeAdvancedValues } from "./settings";

describe("safeAdvancedValues", () => {
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

