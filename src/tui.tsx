/**
 * TUI part: allowance bars inside the right-hand sidebar, refreshed every five
 * minutes (configurable), plus a `/go-usage` refresh command.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { For, Show, createSignal } from "solid-js"
import { GoUsage } from "./rpc.ts"
import type { UsageSnapshot, UsageWindow } from "./usage.ts"

interface State {
  loading: boolean
  snapshot?: UsageSnapshot
  error?: string
}

const [state, setState] = createSignal<State>({ loading: true })
/** Re-rendered every 30s so the reset countdowns stay honest between polls. */
const [tick, setTick] = createSignal(Date.now())

const BAR_CELLS = 10
const LABEL_WIDTH = 4
const RESET_WIDTH = 5
const SEPARATOR_WIDTH = 25

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function colorFor(window: UsageWindow, theme: ResolvedTheme) {
  if (window.percent >= 100) return theme.text.feedback.error.base
  if (window.percent >= 80) return theme.text.feedback.warning.base
  return theme.text.base
}

function cells(percent: number): number {
  return Math.max(0, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS)))
}

/** "1h02m" / "4d13h" / "now" — compact enough for a sidebar. */
function countdown(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ""
  const target = Date.parse(resetsAt)
  if (!Number.isFinite(target)) return ""
  const remaining = target - now
  if (remaining <= 0) return "now"
  const minutes = Math.floor(remaining / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d${String(hours % 24).padStart(2, "0")}h`
  if (hours > 0) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
  return `${minutes}m`
}

function age(fetchedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/** `today` is a number only (the API has no daily window), so it gets no bar. */
function Today(props: { window: UsageWindow }) {
  const context = usePlugin()
  const theme = () => context.theme
  const counter = () => `${String(Math.round(props.window.percent)).padStart(3)}%`
  return (
    <box flexDirection="row">
      <text fg={theme().text.muted}>{"today".padEnd(LABEL_WIDTH + BAR_CELLS + 1)}</text>
      <text fg={colorFor(props.window, theme())}>{counter()}</text>
    </box>
  )
}

function Row(props: { window: UsageWindow }) {
  const context = usePlugin()
  const theme = () => context.theme
  const filled = () => cells(props.window.percent)
  const counter = () => `${String(Math.round(props.window.percent)).padStart(3)}%`
  const reset = () => countdown(props.window.resetsAt, tick())

  // One row of fixed-width <text> runs — the bar glyphs carry the value, so the
  // rows stay aligned and readable in any terminal font.
  return (
    <box flexDirection="row">
      <text fg={theme().text.muted}>{props.window.label.padEnd(LABEL_WIDTH)}</text>
      <text fg={colorFor(props.window, theme())}>{"█".repeat(filled())}</text>
      <text fg={theme().text.faint}>{"░".repeat(BAR_CELLS - filled())}</text>
      <text fg={colorFor(props.window, theme())}>{` ${counter()}`}</text>
      <text fg={theme().text.faint}>{reset() ? ` ${reset().padStart(RESET_WIDTH)}` : ""}</text>
    </box>
  )
}

function Panel() {
  const context = usePlugin()
  const snapshot = (): UsageSnapshot | undefined => state().snapshot
  const error = (): string | undefined => state().error ?? (snapshot()?.ok === false ? snapshot()?.error : undefined)
  const today = (): UsageWindow | undefined => snapshot()?.windows.find((item) => item.id === "today")
  const rest = (): UsageWindow[] => snapshot()?.windows.filter((item) => item.id !== "today") ?? []
  const title = () => {
    const current = snapshot()
    if (current?.ok) return `Go usage · ${age(current.fetchedAt, tick())}`
    if (state().loading) return "Go usage · …"
    return "Go usage"
  }

  return (
    <box flexDirection="column">
      <text fg={context.theme.text.muted}>{title()}</text>
      <Show when={snapshot()?.ok}>
        {today() === undefined ? null : <Today window={today()!} />}
        <text fg={context.theme.text.faint}>{"─".repeat(SEPARATOR_WIDTH)}</text>
        <For each={rest()}>{(item) => <Row window={item} />}</For>
      </Show>
      <Show when={error()}>
        <text fg={context.theme.text.feedback.error.base}>{error()}</text>
      </Show>
      <Show when={snapshot()?.windows.some((window) => window.status !== "ok")}>
        <text fg={context.theme.text.feedback.warning.base}>limit reached</text>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "go-usage.tui",
  setup(context) {
    const configured = Number(context.options.refreshMinutes ?? 5)
    const minutes = Number.isFinite(configured) && configured > 0 ? configured : 5
    const intervalMs = Math.max(30, minutes) * 60_000

    let disposed = false

    async function refresh(force = false, notify = false) {
      try {
        // JSON Schema methods are typed `unknown`; the server part is the only writer.
        const result = (await context.client.rpc(GoUsage).usage({ force })) as UsageSnapshot
        if (disposed) return
        setState({ loading: false, snapshot: result, error: result.ok ? undefined : result.error })
        if (notify) {
          const summary = result.ok
            ? result.windows.map((window) => `${window.label} ${Math.round(window.percent)}%`).join(" · ")
            : (result.error ?? "usage unavailable")
          context.ui.toast.show({
            title: "OpenCode Go",
            message: summary,
            variant: result.ok ? "info" : "error",
          })
        }
      } catch (error) {
        if (disposed) return
        setState((previous) => ({ ...previous, loading: false, error: messageOf(error) }))
      }
    }

    void refresh()

    const poll = setInterval(() => void refresh(), intervalMs)
    const clock = setInterval(() => setTick(Date.now()), 30_000)

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "go-usage.refresh",
          title: "Refresh OpenCode Go usage",
          group: "OpenCode Go",
          palette: true,
          slash: { name: "go-usage", aliases: ["gou"] },
          run: () => refresh(true, true),
        },
      ],
    }))

    context.ui.slot({ append: "sidebar.content", render: () => <Panel /> })

    return () => {
      disposed = true
      clearInterval(poll)
      clearInterval(clock)
    }
  },
})
