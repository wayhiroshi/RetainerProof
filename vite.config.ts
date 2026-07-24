import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    cloudflare({
      remoteBindings: mode !== "test",
    }),
  ],
  server: {
    port: 5173,
  },
}));
