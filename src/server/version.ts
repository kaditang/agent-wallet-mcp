// Single source for the version the MCP server reports in its initialize
// handshake (serverInfo.version). It used to be a literal "0.3.0" in BOTH
// index.ts and stdio.ts, and silently stayed "0.3.0" through the 0.3.1 and
// 0.3.2 releases. Not read from package.json at runtime because the stdio
// entry is bundled to CJS (no import.meta.url); instead version.test.ts fails
// the suite if this drifts from package.json — bump both when releasing.
export const SERVER_VERSION = "0.3.2"
