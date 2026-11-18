/**
 * `today` cannot be read from the API: it reports whole percentages for the
 * 5-hour, weekly and monthly windows and has no daily window. This derives the
 * best figure the data allows, and says how sure it is.
 */
import type { UsageWindow } from "./usage.ts"

/** The rolling window the API reports is always five hours long. */
export const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000

/**
 * Each window's percent is against *its own* allowance, and the Go plan defines
 * those as fractions of the monthly one: 5-hour = 20%, weekly = 50%, monthly =
 * 100%. A 5% reading on the 5-hour bar is therefore 1% of the month.
 */
export const WINDOW_SHARE_OF_MONTH = { rolling: 0.2, weekly: 0.5, monthly: 1 } as const

export interface DayState {
  /** UTC day these numbers belong to, `YYYY-MM-DD`. */
  day: string
  /** Monthly percentage at the start of that day. */
  baseline: number
  /** Last monthly percentage seen that day. */
  last: number
  /** `baseline` came from yesterday's last reading, so `today` is measured. */
  exact: boolean
  /** Largest lower bound established today, kept across 5-hour window resets. */
  floor: number
}

export interface RollingReading {
  percent: number
  resetsAt?: string
}

export interface TodayInput {
  now: number
  monthly: number
  rolling?: RollingReading | undefined
  state?: DayState | undefined
}

export interface TodayResult {
  /** Omitted when the data would only support a claim of zero. */
  today?: UsageWindow
  state: DayState
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function startOfUtcDay(now: number): number {
  return Date.parse(`${utcDay(now)}T00:00:00.000Z`)
}

export function previousDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

/** Milliseconds since the epoch when the rolling window opened, or `NaN`. */
export function rollingWindowStart(reading: RollingReading | undefined): number {
  return reading?.resetsAt ? Date.parse(reading.resetsAt) - ROLLING_WINDOW_MS : Number.NaN
}

export function deriveToday(input: TodayInput): TodayResult {
  const { now, monthly: current, rolling, state: stored } = input
  const day = utcDay(now)

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

  if (exact) {
    // Measured: monthly now against a reading from before midnight.
    return {
      state: { day, baseline, last: current, exact: true, floor: 0 },
      today: {
        id: "today",
        label: "today",
        percent: Math.max(0, current - baseline),
        status: "ok",
      },
    }
  }

  // Lower bound. Everything in a 5-hour window that opened after midnight is
  // today's usage, and the monthly counter cannot move backwards within a day,
  // so the largest bound seen today still holds after that window resets.
  const sinceReading = Math.max(0, current - baseline)
  const start = rollingWindowStart(rolling)
  const rollingToday =
    rolling && Number.isFinite(start) && start >= startOfUtcDay(now)
      ? rolling.percent * WINDOW_SHARE_OF_MONTH.rolling
      : 0
  const carried = stored?.day === day ? (stored.floor ?? 0) : 0
  const floor = Math.max(sinceReading, rollingToday, carried)

  const state: DayState = { day, baseline, last: current, exact: false, floor }
  if (floor <= 0) return { state }

  return {
    state,
    today: { id: "today", label: "today", percent: floor, status: "floor" },
  }
}
