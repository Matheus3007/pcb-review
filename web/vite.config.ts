import { defineConfig } from "vite";

export default defineConfig({
  base: "./", // relative asset URLs: works at a domain root or under a sub-path
  server: {
    // the repo lives on NTFS (/mnt/c): inotify misses edits from WSL, so poll
    watch: { usePolling: true, interval: 300 },
  },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
