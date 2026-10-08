import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tauriConfig from "./src-tauri/tauri.conf.json";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(tauriConfig.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  clearScreen: false,
  build: {
    outDir: "web-dist",
  },
  server: {
    strictPort: true,
    port: 1420,
  },
});
