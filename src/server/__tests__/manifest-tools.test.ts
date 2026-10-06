import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { getToolList } from "../tools.js"

// Tripwire: check_xstock_safety was served by tools/list for months while missing from
// mcp-manifest.json, so any client or registry that builds its catalog from the manifest never
// saw the pre-trade safety check (issue #1). The manifest is hand-written; this keeps it honest.
describe("mcp-manifest.json tools", () => {
  it("lists exactly the tools the server serves", () => {
    const root = path.resolve(__dirname, "../../..")
    const manifest = JSON.parse(readFileSync(path.join(root, "mcp-manifest.json"), "utf8"))
    const listed = (manifest.tools as { name: string }[]).map((t) => t.name).sort()
    const served = getToolList().map((t: { name: string }) => t.name).sort()
    expect(listed).toEqual(served)
  })
})
