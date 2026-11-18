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
const DAY_STATE_KEY = "today-state.v3"

/** The rolling window the API reports is always five hours long. */
const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000

/**
 * Each window reports its percent against *its own* allowance, and the Go plan
 * defines those as fractions of the monthly one: 5-hour = 20%, weekly = 50%,
 * monthly = 100%. So a 5% reading on the 5-hour bar is 1% of the month.
 */
const WINDOW_SHARE_OF_MONTH = { rolling: 0.2, weekly: 0.5, monthly: 1 } as const

interface DayState {
  /** UTC day these numbers belong to, `YYYY-MM-DD`. */
  day: string
  /** Monthly percentage at the start of that day. */
  baseline: number
  /** Last monthly percentage seen that day. */
  last: number
  /** `baseline` came from yesterday's last reading, so `today` is measured. */
  exact: boolean
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function startOfUtcDay(now: number): number {
  return Date.parse(`${utcDay(now)}T00:00:00.000Z`)
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
    const debugOverage =
      typeof ctx.options.overageUsd === "number" ? (ctx.options.overageUsd as number) : undefined

    let cache: { at: number; snapshot: UsageSnapshot } | undefined

    /**
     * The API reports 5-hour / weekly / monthly as whole percentages and has no
     * daily window, so `today` cannot be read directly:
     *
     *   - With a reading from before midnight, `today` is the monthly delta since
     *     then. That is measured, and only as precise as the whole percent the
     *     API reports.
     *   - Without one it is a lower bound: the 5-hour window when it started
     *     after midnight (everything in it is today), or the delta since the
     *     first reading today. A bound of zero means "no information", so the
     *     line is dropped rather than claiming 0%.
     *
     * If the endpoint ever reports absolute money instead of percentages, take
     * the percentages from those rather than differencing rounded ones.
     */
    async function withToday(snapshot: UsageSnapshot): Promise<UsageSnapshot> {
      if (!snapshot.ok) return snapshot
      const monthlyAt = snapshot.windows.findIndex((item) => item.id === "monthly")
      const monthly = snapshot.windows[monthlyAt]
      if (!monthly) return snapshot

      const now = snapshot.fetchedAt
      const day = utcDay(now)
      const current = monthly.percent
      const stored = (await ctx.storage.get(DAY_STATE_KEY)) as DayState | undefined

      let baseline: number
      let exact: boolean
      if (stored?.day === day) {
        baseline = stored.baseline
        exact = stored.exact
      } else if (stored && stored.day === previousDay(day)) {
        // Yesterday's last reading is the closest thing to a midnight baseline.
        baseline = stored.last
        exact = baseline <= current // a billing-period rollover invalidates it
      } else {
        // First day ever, or the plugin was not running yesterday.
        baseline = current
        exact = false
      }

      if (!stored || stored.day !== day || stored.baseline !== baseline || stored.last !== current || stored.exact !== exact) {
        await ctx.storage.set(DAY_STATE_KEY, { day, baseline, last: current, exact } satisfies DayState)
      }

      let today: UsageWindow | undefined
      if (exact) {
        today = { id: "today", label: "today", percent: Math.max(0, current - baseline), status: "ok" }
      } else {
        const sinceReading = Math.max(0, current - baseline)
        const rolling = snapshot.windows.find((item) => item.id === "rolling")
        const rollingStart = rolling?.resetsAt ? Date.parse(rolling.resetsAt) - ROLLING_WINDOW_MS : Number.NaN
        // Everything in a window that opened after midnight is today's usage,
        // converted to the monthly scale the `today` line is shown in.
        const rollingToday =
          rolling && Number.isFinite(rollingStart) && rollingStart >= startOfUtcDay(now)
            ? rolling.percent * WINDOW_SHARE_OF_MONTH.rolling
            : 0
        const floor = Math.max(sinceReading, rollingToday)
        if (floor > 0) today = { id: "today", label: "today", percent: floor, status: "floor" }
      }

      const windows = [...snapshot.windows]
      if (today) windows.splice(monthlyAt, 0, today)

      // Nothing in the API reports money spent past the subscription: the only
      // dollar figures are per response (`usage.opencode.allowance`), there is
      // no month-to-date spend endpoint, and the Console's own figure needs a
      // Console session rather than a Go key. So the line only appears when a
      // figure is genuinely known — `overageUsd` is a harness for testing it.
      const spentOver = debugOverage

      return { ...snapshot, windows, ...(spentOver === undefined ? {} : { spentOver }) }
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
