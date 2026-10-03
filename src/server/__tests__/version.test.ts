import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { SERVER_VERSION } from "../version.js"

// Tripwire: the handshake version stayed "0.3.0" through two releases because
// it was a hand-edited literal. If this fails, bump src/server/version.ts.
describe("serverInfo.version", () => {
  it("matches package.json and server.json", () => {
    const root = path.resolve(__dirname, "../../..")
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
    const srv = JSON.parse(readFileSync(path.join(root, "server.json"), "utf8"))
    expect(SERVER_VERSION).toBe(pkg.version)
    expect(srv.version).toBe(pkg.version)
    for (const p of srv.packages ?? []) expect(p.version).toBe(pkg.version)
  })

  it("matches mcp-manifest.json (stayed 0.3.0 through the 0.3.1/0.3.2 releases)", () => {
    const root = path.resolve(__dirname, "../../..")
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
    const manifest = JSON.parse(readFileSync(path.join(root, "mcp-manifest.json"), "utf8"))
    expect(manifest.version).toBe(pkg.version)
  })
})
