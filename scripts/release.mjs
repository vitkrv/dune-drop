// Version and metadata tooling. No private keys or network access.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
const [command, value] = process.argv.slice(2);
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const versions = () => [readJson("package.json").version, readJson("src-tauri/tauri.conf.json").version,
  readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version = "([^"]+)"/m)[1]];
if (command === "bump") {
  if (!stable.test(value ?? "")) throw Error("Usage: node scripts/release.mjs bump X.Y.Z");
  for (const path of ["package.json", "package-lock.json", "src-tauri/tauri.conf.json"]) {
    const json = readJson(path); json.version = value;
    if (json.packages?.[""]) json.packages[""].version = value;
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  }
  const cargo = "src-tauri/Cargo.toml";
  writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^version = "[^"]+"/m, `version = "${value}"`));
  const lock = "src-tauri/Cargo.lock";
  writeFileSync(lock, readFileSync(lock, "utf8").replace(/(name = "dunedrop"\r?\nversion = ")[^"]+/, `$1${value}`));
} else if (command === "check" || command === "metadata") {
  const [version, ...rest] = versions();
  if (!stable.test(version) || rest.some(v => v !== version) || value !== `v${version}`) throw Error("Tag and package, Cargo, and Tauri stable versions must match");
  if (!readFileSync("src-tauri/update-public-key.txt", "utf8").split(/\r?\n/).some(s => /^RW[A-Za-z0-9+/=]+$/.test(s))) throw Error("Supply the real Minisign public key before releasing");
  if (command === "metadata") {
    const path = "dist/DuneDrop.exe";
    const notes = readFileSync("RELEASE_NOTES.md", "utf8").trim();
    const data = { schemaVersion: 1, version, platform: "windows-x86_64", url: `https://github.com/vitkrv/dune-drop/releases/download/v${version}/DuneDrop.exe`, size: statSync(path).size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), notes };
    const bytes = JSON.stringify(data, null, 2) + "\n";
    if (Buffer.byteLength(bytes) > 65536 || data.size === 0 || data.size > 512 * 1024 * 1024) throw Error("Release exceeds updater limits");
    writeFileSync("dist/update.json", bytes);
  }
} else throw Error("Usage: node scripts/release.mjs bump X.Y.Z | check vX.Y.Z | metadata vX.Y.Z");
