import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

test("release tooling synchronizes versions and hashes final artifacts, failing closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "DuneDrop release tests "));
  const script = resolve("scripts/release.mjs");
  const put = (path, text) => writeFileSync(join(dir, path), text);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
  try {
    mkdirSync(join(dir, "src-tauri")); mkdirSync(join(dir, "dist"));
    put("package.json", '{"version":"1.0.0"}'); put("package-lock.json", '{"version":"1.0.0","packages":{"":{"version":"1.0.0"}}}');
    put("src-tauri/tauri.conf.json", '{"version":"1.0.0"}'); put("src-tauri/Cargo.toml", '[package]\nname = "dunedrop"\nversion = "1.0.0"\n');
    put("src-tauri/Cargo.lock", '[[package]]\nname = "dunedrop"\nversion = "1.0.0"\n');
    put("src-tauri/update-public-key.txt", "UNCONFIGURED");
    assert.notEqual(run("check", "v1.0.0").status, 0);
    put("src-tauri/update-public-key.txt", "RWtestkey");
    assert.equal(run("bump", "1.2.0").status, 0);
    assert.match(readFileSync(join(dir, "src-tauri/Cargo.lock"), "utf8"), /version = "1.2.0"/);
    assert.equal(run("check", "v1.2.0").status, 0);
    assert.notEqual(run("check", "v1.2.1").status, 0);
    assert.notEqual(run("bump", "01.2.0").status, 0);
    put("dist/DuneDrop.exe", "disposable executable"); put("RELEASE_NOTES.md", "Release notes");
    assert.equal(run("metadata", "v1.2.0").status, 0);
    const m = JSON.parse(readFileSync(join(dir, "dist/update.json"), "utf8"));
    assert.equal(m.sha256, createHash("sha256").update("disposable executable").digest("hex"));
    assert.equal(m.size, Buffer.byteLength("disposable executable"));
    assert.equal(m.version, "1.2.0"); assert.equal(m.platform, "windows-x86_64");
    assert.equal(m.url, "https://github.com/vitkrv/dune-drop/releases/download/v1.2.0/DuneDrop.exe");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
