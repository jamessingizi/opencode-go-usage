/**
 * TUI part: OpenCode Go allowance inside the right-hand sidebar.
 *
 * Polling belongs to the mounted panel, not to setup: a plugin reload disposes
 * setup's timers while the host can keep the last rendered panel on screen, and
 * the panel then sits there frozen. A component that owns its own timer keeps
 * updating for as long as it is actually on screen.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { GoUsage } from "./rpc.ts"
import { errorMessage, type UsageSnapshot, type UsageWindow } from "./usage.ts"

interface State {
  loading: boolean
  snapshot?: UsageSnapshot
  error?: string
}

const [state, setState] = createSignal<State>({ loading: true })
/** Re-rendered every 30s so the age and reset countdowns stay honest. */
const [tick, setTick] = createSignal(Date.now())

/** After a failure, try again sooner than the normal interval. */
const RETRY_MS = 30_000

const BAR_CELLS = 10
const LABEL_WIDTH = 4
/** Digits only: the API reports whole percents, so "100" is the widest. */
const PERCENT_WIDTH = 3
const RESET_WIDTH = 5
/** label + bar + "≥100%" + space + countdown. */
const VALUE_COLUMN = LABEL_WIDTH + BAR_CELLS
const LINE_WIDTH = VALUE_COLUMN + 1 + PERCENT_WIDTH + 1 + 1 + RESET_WIDTH

function colorFor(window: UsageWindow, theme: ResolvedTheme) {
  if (window.percent >= 100) return theme.text.feedback.error.base
  if (window.percent >= 80) return theme.text.feedback.warning.base
  return theme.text.base
}

/**
 * Whole percents, matching what the endpoint reports. `prefix` is the whole
 * first column, so a `≥` lower bound lines up with the plain values instead of
 * pushing the row out.
 */
function percentField(value: number, prefix = " "): string {
  return `${prefix}${String(Math.round(value)).padStart(PERCENT_WIDTH)}%`
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
  if (seconds < 45) return ""
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

/** `today` is a number only — the API has no daily window — so it gets no bar. */
function Today(props: { window: UsageWindow }) {
  const context = usePlugin()
  const theme = () => context.theme
  const floor = () => props.window.status === "floor"
  return (
    <box flexDirection="row">
      <text fg={theme().text.muted}>{"today".padEnd(VALUE_COLUMN)}</text>
      <text fg={floor() ? theme().text.faint : colorFor(props.window, theme())}>
        {percentField(props.window.percent, floor() ? "≥" : " ")}
      </text>
    </box>
  )
}

function Row(props: { window: UsageWindow }) {
  const context = usePlugin()
  const theme = () => context.theme
  const filled = () => cells(props.window.percent)
  const reset = () => countdown(props.window.resetsAt, tick())

  // Fixed-width <text> runs: the bar glyphs carry the value, so rows stay
  // aligned in any terminal font. The bar is one run — a zero-width run for an
  // empty half collapses and shifts the row.
  const bar = () => "█".repeat(filled()) + "░".repeat(BAR_CELLS - filled())
  return (
    <box flexDirection="row">
      <text fg={theme().text.muted}>{props.window.label.padEnd(LABEL_WIDTH)}</text>
      <text fg={colorFor(props.window, theme())}>{bar()}</text>
      <text fg={colorFor(props.window, theme())}>{percentField(props.window.percent)}</text>
      <text fg={theme().text.faint}>{` ${reset().padStart(RESET_WIDTH)}`}</text>
    </box>
  )
}

interface PanelProps {
  collapsed: boolean
  onToggle: () => void
  /** Refreshes and reports whether it succeeded. */
  poll: (force: boolean) => Promise<boolean>
  intervalMs: number
}

function Panel(props: PanelProps) {
  const context = usePlugin()
  const snapshot = (): UsageSnapshot | undefined => state().snapshot
  const error = (): string | undefined =>
    state().error ?? (snapshot()?.ok === false ? snapshot()?.error : undefined)
  const today = (): UsageWindow | undefined => snapshot()?.windows.find((item) => item.id === "today")
  const rest = (): UsageWindow[] => snapshot()?.windows.filter((item) => item.id !== "today") ?? []
  const fresh = () => (snapshot() ? age(snapshot()!.fetchedAt, tick()) : "")

  onMount(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = () => setTick(Date.now())
    const clock = setInterval(tick, 30_000)

    const run = async () => {
      const ok = await props.poll(false)
      if (stopped) return
      timer = setTimeout(run, ok ? props.intervalMs : RETRY_MS)
    }

    void run()

    onCleanup(() => {
      stopped = true
      clearInterval(clock)
      if (timer !== undefined) clearTimeout(timer)
    })
  })

  return (
    <box flexDirection="column">
      <box flexDirection="row" onMouseDown={props.onToggle}>
        <text fg={context.theme.text.muted}>{props.collapsed ? "▸ " : "▾ "}</text>
        <text fg={context.theme.text.base}>OpenCode Go Usage</text>
        <text fg={context.theme.text.faint}>{fresh() ? ` ${fresh()}` : ""}</text>
      </box>
      <Show when={!props.collapsed}>
        <Show when={snapshot()?.ok}>
          {today() === undefined ? null : <Today window={today()!} />}
          <text fg={context.theme.text.faint}>{"─".repeat(LINE_WIDTH)}</text>
          <For each={rest()}>{(item) => <Row window={item} />}</For>
        </Show>
        <Show when={error()}>
          <text fg={context.theme.text.feedback.error.base}>{error()}</text>
        </Show>
        <Show when={snapshot()?.windows.some((window) => window.status === "limit_reached")}>
          <text fg={context.theme.text.feedback.warning.base}>limit reached</text>
        </Show>
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

    const [ui, updateUI] = context.storage.store("panel", { initial: { collapsed: false } })
    const toggle = () =>
      void updateUI((draft) => {
        draft.collapsed = !draft.collapsed
      })

    let disposed = false

    /** Reads the live client each call: it changes after a server restart. */
    async function poll(force: boolean): Promise<boolean> {
      try {
        const client = context.client.rpc(GoUsage)
        // JSON Schema methods are typed `unknown`; the server part is the only writer.
        const result = (force ? await client.refresh({}) : await client.usage({})) as UsageSnapshot
        if (disposed) return false
        setState({ loading: false, snapshot: result, error: result.ok ? undefined : result.error })
        return true
      } catch (error) {
        if (disposed) return false
        setState((previous) => ({ ...previous, loading: false, error: errorMessage(error) }))
        return false
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "go-usage.refresh",
          title: "Refresh OpenCode Go usage",
          group: "OpenCode Go",
          palette: true,
          slash: { name: "go-usage", aliases: ["gou"] },
          run: async () => {
            const ok = await poll(true)
            const current = state()
            const summary = !ok
              ? (error() ?? "usage unavailable")
              : current.snapshot?.ok
                ? current.snapshot.windows
                    .map((window) => `${window.label} ${Math.round(window.percent)}%`)
                    .join(" · ")
                : (current.snapshot?.error ?? "usage unavailable")
            context.ui.toast.show({
              title: "OpenCode Go",
              message: summary,
              variant: ok && current.snapshot?.ok ? "info" : "error",
            })
          },
        },
        {
          id: "go-usage.toggle",
          title: "Collapse or expand Go usage",
          group: "OpenCode Go",
          palette: true,
          run: () => toggle(),
        },
      ],
    }))

    function error(): string | undefined {
      return state().error ?? (state().snapshot?.ok === false ? state().snapshot?.error : undefined)
    }

    // Belt and braces: the mounted panel owns its own timer, and this one keeps
    // the shared state fresh even if the host leaves the panel unmounted (a
    // sidebar that is closed, or a stale render from before a reload). The
    // server caches for a minute, so the extra call is free.
    const fallback = setInterval(() => void poll(false), intervalMs)

    context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Panel
          collapsed={ui.collapsed}
          onToggle={toggle}
          poll={poll}
          intervalMs={intervalMs}
        />
      ),
    })

    return () => {
      disposed = true
      clearInterval(fallback)
    }
  },
})
