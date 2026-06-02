import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    outDir: "web-dist",
  },
  server: {
    strictPort: true,
    port: 1420,
  },
});
