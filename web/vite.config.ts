import { defineConfig } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { resolve } from "node:path"

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ["events", "buffer", "process", "stream", "util", "crypto"],
      globals: { Buffer: true, process: true, global: true },
    }),
  ],
  server: { port: 5173 },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sign: resolve(__dirname, "sign.html"),
        account: resolve(__dirname, "account.html"),
      },
    },
  },
})
