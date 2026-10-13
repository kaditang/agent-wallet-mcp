import "./setup.js"
import fs from "node:fs"
import { describe, expect, it } from "vitest"
import request from "supertest"
import { app } from "../index.js"
import { flushAuditSync } from "../audit.js"

const lastAudit = () => {
  flushAuditSync()
  const lines = fs.readFileSync(process.env.AUDIT_LOG_PATH!, "utf8").trim().split("\n")
  return JSON.parse(lines[lines.length - 1])
}
const register = (headers: Record<string, string>) =>
  request(app).post("/register").set(headers).send({ client_name: "ip-test", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })

describe("client IP behind Fly", () => {
  it("uses Fly-Client-IP (audit + rate limiting read req.ip)", async () => {
    await register({ "Fly-Client-IP": "203.0.113.7", "X-Forwarded-For": "203.0.113.7, 66.241.125.125" })
    expect(lastAudit().ip).toBe("203.0.113.7")
  })

  it("accepts IPv6", async () => {
    await register({ "Fly-Client-IP": "2001:db8::42" })
    expect(lastAudit().ip).toBe("2001:db8::42")
  })

  it("ignores a malformed Fly-Client-IP", async () => {
    await register({ "Fly-Client-IP": "not-an-ip; DROP" })
    expect(lastAudit().ip).not.toBe("not-an-ip; DROP")
  })
})
