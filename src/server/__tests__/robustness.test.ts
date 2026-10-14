import "./setup.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { loadJsonFile } from "../safe-json.js"
import { withDeadline } from "../mcp-server.js"
import { isCandidatePool } from "../../sol/yields.js"

describe("robustness", () => {
  it("a corrupt store file is moved aside, never left to be overwritten", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ay-safejson-"))
    const f = path.join(dir, "api-keys.json")
    fs.writeFileSync(f, '{"keys": {"ak_1": ') // truncated write
    expect(loadJsonFile(f, "test")).toBeUndefined()
    expect(fs.existsSync(f)).toBe(false)
    const aside = fs.readdirSync(dir).filter((n) => n.startsWith("api-keys.json.corrupt-"))
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, aside[0]), "utf8")).toContain("ak_1")
  })

  it("missing file → undefined; valid file → parsed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ay-safejson-"))
    expect(loadJsonFile(path.join(dir, "nope.json"), "test")).toBeUndefined()
    fs.writeFileSync(path.join(dir, "ok.json"), '{"a":1}')
    expect(loadJsonFile(path.join(dir, "ok.json"), "test")).toEqual({ a: 1 })
  })

  it("withDeadline rejects a slow call with a readable message and passes fast ones through", async () => {
    await expect(withDeadline(new Promise(() => {}), 20, "export_history")).rejects.toThrow(/export_history took longer than/)
    await expect(withDeadline(Promise.resolve(7), 1000, "x")).resolves.toBe(7)
  })

  it("yields cache keeps exactly what compareYields can use", () => {
    expect(isCandidatePool({ symbol: "usdc", project: "aave-v3" })).toBe(true)
    expect(isCandidatePool({ symbol: "USDY", project: "ondo-finance" })).toBe(true)
    expect(isCandidatePool({ symbol: "WETH", project: "aave-v3" })).toBe(false)
    expect(isCandidatePool({})).toBe(false)
  })
})
