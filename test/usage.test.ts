import { describe, expect, test } from "bun:test"
import { deriveToday, rollingWindowStart, utcDay, type DayState } from "../src/today.ts"
import { errorMessage, parseUsage } from "../src/usage.ts"

const NOW = Date.parse("2026-11-18T12:00:00.000Z")
const fiveHoursLater = (now: number) => new Date(now + 5 * 60 * 60 * 1000).toISOString()

describe("parseUsage", () => {
  test("maps the three windows in order", () => {
    const snapshot = parseUsage(
      {
        usage: {
          rolling: { status: "ok", percent: 4, resetsAt: "2026-11-18T11:51:02.000Z" },
          weekly: { status: "ok", percent: 12, resetsAt: "2026-11-23T00:00:00.000Z" },
          monthly: { status: "ok", percent: 77, resetsAt: "2026-11-21T18:06:01.000Z" },
        },
      },
      NOW,
    )
    expect(snapshot.ok).toBe(true)
    expect(snapshot.windows.map((window) => window.id)).toEqual(["rolling", "weekly", "monthly"])
    expect(snapshot.windows[2]?.percent).toBe(77)
  })

  test("reports an api error body", () => {
    const snapshot = parseUsage(
      { error: { type: "authentication_error", code: "api_key_expired", message: "This API key has expired." } },
      NOW,
    )
    expect(snapshot.ok).toBe(false)
    expect(snapshot.error).toBe("This API key has expired.")
  })

  test("rejects a body with no windows", () => {
    expect(parseUsage({ usage: {} }, NOW)).toMatchObject({ ok: false, windows: [] })
  })
})

describe("deriveToday", () => {
  test("first day without a rolling window makes no claim", () => {
    const { today, state } = deriveToday({ now: NOW, monthly: 77 })
    expect(today).toBeUndefined()
    expect(state).toEqual<DayState>({ day: "2026-11-18", baseline: 77, last: 77, exact: false, floor: 0 })
  })

  test("first day falls back to the 5h window, scaled to the month", () => {
    const { today } = deriveToday({
      now: NOW,
      monthly: 77,
      rolling: { percent: 5, resetsAt: fiveHoursLater(NOW) },
    })
    expect(today).toMatchObject({ id: "today", percent: 1, status: "floor" })
  })

  test("a rolling window that spans midnight is not today's usage", () => {
    // At 03:00 UTC a window that resets at 04:00 opened at 23:00 yesterday.
    const early = Date.parse("2026-11-18T03:00:00.000Z")
    const { today } = deriveToday({
      now: early,
      monthly: 77,
      rolling: { percent: 5, resetsAt: "2026-11-18T04:00:00.000Z" },
    })
    expect(today).toBeUndefined()
  })

  test("yesterday's last reading anchors a measured value", () => {
    const state: DayState = { day: "2026-11-17", baseline: 70, last: 75, exact: true, floor: 0 }
    const { today } = deriveToday({ now: NOW, monthly: 77, state })
    expect(today).toMatchObject({ percent: 2, status: "ok" })
  })

  test("a measured value survives later polls of the same day", () => {
    const state: DayState = { day: "2026-11-18", baseline: 75, last: 76, exact: true, floor: 0 }
    const { today, state: next } = deriveToday({ now: NOW, monthly: 78, state })
    expect(today).toMatchObject({ percent: 3, status: "ok" })
    expect(next).toMatchObject({ baseline: 75, last: 78, exact: true })
  })

  test("a billing-period rollover does not produce a negative day", () => {
    const state: DayState = { day: "2026-11-17", baseline: 90, last: 92, exact: true, floor: 0 }
    const { today, state: next } = deriveToday({
      now: NOW,
      monthly: 3,
      rolling: { percent: 5, resetsAt: fiveHoursLater(NOW) },
      state,
    })
    expect(next.exact).toBe(false)
    expect(today).toMatchObject({ percent: 1, status: "floor" })
  })

  test("the day's floor survives a 5-hour window reset", () => {
    // The window that covered the morning opened today and read 5%; the new one
    // has just started at 0%.
    const morning = deriveToday({
      now: Date.parse("2026-11-18T10:00:00.000Z"),
      monthly: 77,
      rolling: { percent: 5, resetsAt: "2026-11-18T11:51:02.000Z" },
    })
    expect(morning.today).toMatchObject({ percent: 1, status: "floor" })

    const after = deriveToday({
      now: Date.parse("2026-11-18T12:05:00.000Z"),
      monthly: 77,
      rolling: { percent: 0, resetsAt: "2026-11-18T16:58:13.000Z" },
      state: morning.state,
    })
    expect(after.today).toMatchObject({ percent: 1, status: "floor" })
  })

  test("growth since today's first reading is a floor even without the rolling window", () => {
    const state: DayState = { day: "2026-11-18", baseline: 75, last: 75, exact: false, floor: 0 }
    const { today } = deriveToday({ now: NOW, monthly: 77, state })
    expect(today).toMatchObject({ percent: 2, status: "floor" })
  })
})

describe("dates", () => {
  test("utcDay and the rolling window start", () => {
    expect(utcDay(NOW)).toBe("2026-11-18")
    expect(rollingWindowStart({ percent: 5, resetsAt: "2026-11-18T11:51:02.000Z" })).toBe(
      Date.parse("2026-11-18T06:51:02.000Z"),
    )
    expect(rollingWindowStart({ percent: 5 })).toBeNaN()
  })
})

describe("errorMessage", () => {
  test("reads an Error, a string and an RPC failure object", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
    expect(errorMessage("plain")).toBe("plain")
    expect(errorMessage({ type: "rpc.method_not_found", message: "Not found" })).toBe(
      "rpc.method_not_found: Not found",
    )
    expect(errorMessage({ message: "no type" })).toBe("no type")
  })

  test("never renders an object literal", () => {
    expect(errorMessage({ weird: true })).toBe('{"weird":true}')
    expect(errorMessage(undefined)).toBe("undefined")
  })
})
