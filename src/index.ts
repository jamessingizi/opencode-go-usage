/**
 * Server part: resolves the active OpenCode Go credential and asks the Console
 * gateway how much of the allowance has been used.
 *
 * The credential never leaves the server. The TUI part only ever sees the
 * percentages, over RPC.
 */
import { Plugin } from "@opencode/plugin"
import { GoUsage } from "./rpc.ts"
import { fetchUsage, type UsageSnapshot, type UsageWindow } from "./usage.ts"

/** Integration id OpenCode stores `/connect` → OpenCode Go credentials under. */
const INTEGRATION_ID = "opencode-go"

const DEFAULT_CACHE_SECONDS = 60

/** Where the start-of-day monthly reading is kept, for the `today` figure. */
const DAY_STATE_KEY = "today-state"

interface DayState {
  /** UTC day these numbers belong to, `YYYY-MM-DD`. */
  day: string
  /** Monthly percentage at the start of that day. */
  baseline: number
  /** Last monthly percentage seen that day. */
  last: number
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function previousDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

export default Plugin.define({
  id: "go-usage",
  async setup(ctx) {
    const cacheMs = Math.max(0, Number(ctx.options.cacheSeconds ?? DEFAULT_CACHE_SECONDS) * 1000)
    const baseUrl = typeof ctx.options.apiBaseUrl === "string" ? ctx.options.apiBaseUrl : undefined

    let cache: { at: number; snapshot: UsageSnapshot } | undefined

    /**
     * The API exposes 5-hour / weekly / monthly only, so "today" is
     * reconstructed from the monthly counter:
     *
     *   today = monthly now - monthly at 00:00 UTC
     *
     * The start-of-day baseline is the last monthly reading of the previous
     * day when the plugin was already running, otherwise the first reading of
     * today. It is durable, so restarts and new TUI sessions keep it. Monthly
     * percentages are whole numbers, so the figure is accurate to one point.
     */
    async function withToday(snapshot: UsageSnapshot): Promise<UsageSnapshot> {
      if (!snapshot.ok) return snapshot
      const at = snapshot.windows.findIndex((window) => window.id === "monthly")
      const monthly = snapshot.windows[at]
      if (!monthly) return snapshot

      const day = utcDay(snapshot.fetchedAt)
      const current = monthly.percent
      const stored = (await ctx.storage.get(DAY_STATE_KEY)) as DayState | undefined

      let baseline: number
      if (stored?.day === day) baseline = stored.baseline
      else if (stored && stored.day === previousDay(day)) baseline = stored.last
      else baseline = current // first day, or the plugin was not running yesterday
      // The billing period rolled over: nothing consumed today yet.
      if (baseline > current) baseline = current

      if (!stored || stored.day !== day || stored.baseline !== baseline || stored.last !== current) {
        await ctx.storage.set(DAY_STATE_KEY, { day, baseline, last: current } satisfies DayState)
      }

      const today: UsageWindow = {
        id: "today",
        label: "today",
        percent: Math.max(0, current - baseline),
        status: "ok",
      }
      const windows = [...snapshot.windows]
      windows.splice(at, 0, today)
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
