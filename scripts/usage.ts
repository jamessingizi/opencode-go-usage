/**
 * Smoke test for the usage endpoint, without the TUI.
 *
 *   OPENCODE_GO_KEY=oc_sk_... bun scripts/usage.ts
 *
 * With no environment variable it reads the active `opencode-go` credential
 * out of OpenCode's own credential store (`~/.local/share/opencode/opencode.db`)
 * so you can check a real machine. The plugin itself never does this — the
 * server part resolves the credential through `ctx.integration.connection`,
 * which is the supported path and works for remote servers too.
 */
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { fetchUsage } from "../src/usage.ts"

function fromCredentialStore(): string | undefined {
  const path = process.env.OPENCODE_DB ?? join(homedir(), ".local", "share", "opencode", "opencode.db")
  try {
    const db = new Database(path, { readonly: true })
    const row = db
      .query(
        `select json_extract(value, '$.key') as key
           from credential
          where integration_id = 'opencode-go' and active = 1
          order by time_updated desc
          limit 1`,
      )
      .get() as { key?: string } | null
    db.close()
    return row?.key
  } catch {
    return undefined
  }
}

const key = process.env.OPENCODE_GO_KEY?.trim() || fromCredentialStore()
if (!key) {
  console.error("no key: set OPENCODE_GO_KEY or connect OpenCode Go in OpenCode")
  process.exit(1)
}

const snapshot = await fetchUsage(key)
console.log(JSON.stringify(snapshot, null, 2))
process.exit(snapshot.ok ? 0 : 1)
