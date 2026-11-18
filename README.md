# opencode-go-usage

OpenCode Go allowance in the OpenCode TUI sidebar: today's consumption, the
5-hour window, the week and the billing period, refreshed every five minutes.

```
Go usage · just now
today           12%
─────────────────────────
5h   ░░░░░░░░░░   4% 1h02m
wk  █░░░░░░░░░  12% 4d13h
mo  ██████████  100% 3d07h
```

The right-hand column of the three bars is the time until that window resets.
Bars turn amber at 80% and red at 100%.

## Install

```
git clone <this repo> opencode-go-usage
cd opencode-go-usage && bun install
```

Then point OpenCode at the directory — in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-go-usage"],
}
```

Config reloads on save (`/reload` forces it). The sidebar appears in the
session view; `Ctrl+P` toggles it.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-go-usage",
      "options": {
        "refreshMinutes": 5, // poll interval, minimum 30s
        "cacheSeconds": 60, // server-side cache shared by every TUI
      },
    },
  ],
}
```

## The key

Nothing is configured by hand. The server part reads the active
`opencode-go` credential from OpenCode's credential store through the plugin
SDK:

```ts
const connection = await ctx.integration.connection.active("opencode-go")
const credential = await ctx.integration.connection.resolve(connection)
```

so it follows `/connect` → OpenCode Go, and `/credential` switches, without the
key ever reaching the TUI part. If no key is connected the panel says so
instead of failing.

**The API key needs the `usage: read` aspect.** Create or edit the key in the
[Console](https://opencode.ai/console/account#api-keys) with `usage: read`
enabled alongside whatever the model calls need. Keys minted without it can
still run inference but are rejected by the usage endpoint (`401`), which the
panel reports verbatim.

## How it gets the numbers

`GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <key>`:

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 4, "resetsAt": "2026-11-18T11:51:02.000Z" },
    "weekly": { "status": "ok", "percent": 12, "resetsAt": "2026-11-23T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 77, "resetsAt": "2026-11-21T18:06:01.000Z" }
  }
}
```

That is the endpoint the Console Go page uses. It is not in the public API
docs, there is no daily window, and it needs no other scope.

- `rolling` is the 5-hour window (20% of the monthly allowance).
- `weekly` is 50% of the monthly allowance, resetting Monday 00:00 UTC.
- `monthly` is the billing period.

`today` is therefore derived, not fetched:

```
today = monthly now - monthly at 00:00 UTC
```

The start-of-day baseline is the last monthly reading of the previous day, or
the first reading of today if the plugin was not running yesterday. It lives in
plugin storage, so it survives restarts and is shared by every TUI. Monthly
percentages are whole numbers, so `today` is accurate to one point, and on the
very first run it starts from whatever the monthly counter reads at that moment.

## Layout notes

The bars are `█`/`░` glyphs in fixed-width `<text>` runs rather than background
colours: OpenTUI 0.8.4 drops `fg`/`bg` on `<span>`, and space-only runs collapse,
which made the rows drift.

## Development

```
bun install
bunx tsc --noEmit          # typecheck
bun scripts/usage.ts       # hit the endpoint with the active local credential
```

`scripts/usage.ts` reads the credential straight out of
`~/.local/share/opencode/opencode.db` for convenience; the plugin itself always
goes through the SDK.
