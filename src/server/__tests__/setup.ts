// Test env bootstrap. Imported by every test file BEFORE it imports server
// modules so persistence paths point at tmp and not at the dev data/ dir.
import os from "node:os"
import path from "node:path"
import fs from "node:fs"

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "autoyield-test-"))

process.env.NODE_ENV = "test"
process.env.SIGN_STORE_PATH = path.join(TMP_ROOT, "sign-store.json")
process.env.AUDIT_LOG_PATH = path.join(TMP_ROOT, "audit.log")
process.env.AUTH_STORE_PATH = path.join(TMP_ROOT, "api-keys.json")
process.env.OAUTH_CLIENTS_PATH = path.join(TMP_ROOT, "oauth-clients.json")
process.env.METRICS_PATH = path.join(TMP_ROOT, "metrics.json")
process.env.METRICS_TOKEN = "test-metrics-token"
// Many full OAuth flows run against one in-process app from one IP.
process.env.RATE_LIMIT_SCALE = "20"
process.env.DEMO_TOKENS = "testtok:testuser"
// Don't actually go to a real RPC during tests; default fallbacks satisfy the
// "at least one endpoint" guard in connection.ts.
process.env.SOL_RPC = "https://api.mainnet-beta.solana.com"
// Silence Sentry — no DSN means initSentry() no-ops.
delete process.env.SENTRY_DSN

export { TMP_ROOT }
