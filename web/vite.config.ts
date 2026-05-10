import { defineConfig } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ["events", "buffer", "process", "stream", "util", "crypto"],
      globals: { Buffer: true, process: true, global: true },
    }),
  ],
  server: { port: 5173 },
})
