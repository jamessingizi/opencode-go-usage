/**
 * The RPC contract between the server part and the TUI part.
 *
 * The server part owns the credential (only the server can resolve an
 * integration credential), the TUI part owns the rendering.
 */
import { Rpc } from "@opencode/plugin/rpc"

const window = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    percent: { type: "number" },
    status: { type: "string" },
    resetsAt: { type: "string" },
  },
  required: ["id", "label", "percent", "status"],
} as const

export const GoUsage = Rpc.define({
  id: "go-usage",
  methods: {
    usage: {
      input: {
        type: "object",
        properties: {
          /** Bypass the server-side cache. Used by the manual refresh command. */
          force: { type: "boolean" },
        },
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          fetchedAt: { type: "number" },
          windows: { type: "array", items: window },
          error: { type: "string" },
          /** True when the server answered from its own short-lived cache. */
          cached: { type: "boolean" },
        },
        required: ["ok", "fetchedAt", "windows"],
      },
      errors: {
        not_connected: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
          required: ["message"],
        },
      },
    },
  },
  events: {},
})
