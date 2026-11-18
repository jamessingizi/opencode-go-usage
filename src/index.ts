/**
 * Server part: resolves the active OpenCode Go credential and asks the Console
 * gateway how much of the allowance has been used.
 *
 * The credential never leaves the server. The TUI part only ever sees the
 * percentages, over RPC.
 */
import { Plugin } from "@opencode/plugin"
import { GoUsage } from "./rpc.ts"
import { deriveToday, type DayState } from "./today.ts"
import { fetchUsage, type UsageSnapshot } from "./usage.ts"

/** Integration id OpenCode stores `/connect` → OpenCode Go credentials under. */
const INTEGRATION_ID = "opencode-go"

const DEFAULT_CACHE_SECONDS = 60

/** Where the start-of-day monthly reading is kept, for the `today` figure. */
const DAY_STATE_KEY = "today-state.v3"

export default Plugin.define({
  id: "go-usage",
  async setup(ctx) {
    const cacheMs = Math.max(0, Number(ctx.options.cacheSeconds ?? DEFAULT_CACHE_SECONDS) * 1000)
    const baseUrl = typeof ctx.options.apiBaseUrl === "string" ? ctx.options.apiBaseUrl : undefined
    let cache: { at: number; snapshot: UsageSnapshot } | undefined

    async function withToday(snapshot: UsageSnapshot): Promise<UsageSnapshot> {
      if (!snapshot.ok) return snapshot
      const monthlyAt = snapshot.windows.findIndex((item) => item.id === "monthly")
      const monthly = snapshot.windows[monthlyAt]
      if (!monthly) return snapshot

      const rolling = snapshot.windows.find((item) => item.id === "rolling")
      const stored = (await ctx.storage.get(DAY_STATE_KEY)) as DayState | undefined
      const result = deriveToday({ now: snapshot.fetchedAt, monthly: monthly.percent, rolling, state: stored })

      const previous = stored
      if (
        !previous ||
        previous.day !== result.state.day ||
        previous.baseline !== result.state.baseline ||
        previous.last !== result.state.last ||
        previous.exact !== result.state.exact ||
        previous.floor !== result.state.floor
      ) {
        // Storage takes plain JSON; DayState has no index signature.
        await ctx.storage.set(DAY_STATE_KEY, result.state as unknown as Record<string, string | number | boolean>)
      }

      const windows = [...snapshot.windows]
      if (result.today) windows.splice(monthlyAt, 0, result.today)
      return { ...snapshot, windows }
    }

    async function load(signal: AbortSignal | undefined, force: boolean): Promise<UsageSnapshot> {
      if (!force && cache && Date.now() - cache.at < cacheMs) return cache.snapshot

      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) {
        return {
          ok: false,
          fetchedAt: Date.now(),
          windows: [],
          error: "OpenCode Go is not connected. Run /connect and pick OpenCode Go.",
        }
      }

      const credential = await ctx.integration.connection.resolve(connection)
      if (!credential || credential.type !== "key") {
        return {
          ok: false,
          fetchedAt: Date.now(),
          windows: [],
          error: "The active OpenCode Go connection does not hold an API key.",
        }
      }

      const snapshot = await withToday(await fetchUsage(credential.key, { signal, baseUrl }))
      // Only cache a good answer, so a transient failure retries on the next poll.
      if (snapshot.ok) cache = { at: Date.now(), snapshot }
      return snapshot
    }

    await ctx.rpc.register(GoUsage, {
      usage: async (input, context) => {
        const force = (input as { force?: boolean } | undefined)?.force === true
        return load(context.signal, force)
      },
    })
  },
})
