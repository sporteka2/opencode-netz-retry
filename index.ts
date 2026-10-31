import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync, existsSync } from "node:fs"

// Failures worth retrying: DNS/connectivity problems plus transient HTTP
// errors from the provider (429, 502/503/504 and "Internal server error").
// Deliberately excludes auth and validation errors: those never succeed on
// retry and would just hammer a working credential.
const NETWORK_MESSAGE =
  /getaddrinfo|EAI_AGAIN|EAI_FAIL|ENOTFOUND|ETIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|fetch failed|network error|terminated|internal server error|bad gateway|service unavailable|gateway timeout|overloaded|too many requests|rate limit/i
const NETWORK_TYPE = /^(provider\.(transport|too_many_requests|overloaded|server_error|rate_limit)|APIError)$/

// Presence of this file pauses automatic re-prompts immediately (control switch).
const PAUSE_FILE = "/tmp/opencode/netz-retry-paused"

const PLUGIN = "[netz-retry]"
const DEBUG = "/tmp/opencode/netz-retry-debug.log"

function dbg(line: string): void {
  try {
    mkdirSync("/tmp/opencode", { recursive: true })
    appendFileSync(DEBUG, `${new Date().toISOString()} ${line}\n`)
  } catch (err) {
    // debug logging must never break the plugin; surface why it failed
    console.log(`${PLUGIN} fs-debug unavailable:`, err instanceof Error ? err.message : err)
  }
}

function retryable(type?: string, message?: string): boolean {
  return NETWORK_MESSAGE.test(message ?? "") || NETWORK_TYPE.test(type ?? "")
}

interface FailureEventData {
  sessionID?: string
  error?: { type?: string; message?: string; status?: number }
}

export default Plugin.define({
  id: "netz-retry",
  async setup(ctx) {
    const options = (ctx.options as { reprompt?: boolean; delay?: number } | undefined) ?? {}
    const REPROMPT = options.reprompt !== false
    const DELAY = Math.max(1_000, options.delay ?? 10_000)
    // Number of re-prompt cycles per session before giving up (safety valve).
    const MAX_REPROMPTS = 120

    // Per-session counter of automatic re-prompt cycles, and dedupe of
    // execution-failure events (the stream can deliver one event twice).
    const cycles = new Map<string, number>()
    const seenEvents = new Set<string>()

    // 1) In-request retries: make network/transient-provider errors retryable
    // for the nvidia provider. The built-in attempt cap still applies inside
    // one request, but this ensures those failures use that whole budget.
    await ctx.session.hook("retry", (event) => {
      if (event.model.providerID !== "nvidia") return
      if (!retryable(event.error.type, event.error.message)) return
      // Prefer the user-configured delay; otherwise exponential backoff 5s → 20s.
      const delay = options.delay
        ? Math.max(1_000, options.delay)
        : Math.min(20_000, 5_000 * event.attempt)
      dbg(`${PLUGIN} retryable failure on attempt ${event.attempt}, retry in ${delay}ms (type=${event.error.type})`)
      event.decision = { retry: true, delay }
    })

    if (!REPROMPT) return

    // 2) Final-failure recovery: when a request still dies on a retryable
    // error (the in-request cap was exhausted), wait DELAY and re-submit the
    // last user prompt of that session until it succeeds or the user interrupts.
    // Guard: the plugin may be instantiated twice (locations/reloads); keep
    // only the newest subscription.
    const g = globalThis as { __netzRetryLoop?: AbortController }
    if (g.__netzRetryLoop) {
      dbg(`${PLUGIN} stopping previous subscription instance`)
      g.__netzRetryLoop.abort()
    }
    const controller = new AbortController()
    g.__netzRetryLoop = controller

    void (async () => {
      dbg(`${PLUGIN} event subscription started`)
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const typed = event as { id?: string; type?: string; data?: FailureEventData }
          const type = typed.type ?? ""
          if (
            type !== "session.execution.failed" &&
            type !== "session.execution.interrupted" &&
            type !== "session.execution.succeeded"
          ) {
            continue
          }
          // The stream can deliver one event twice; process each once only.
          if (typed.id && seenEvents.has(typed.id)) continue
          if (typed.id) {
            seenEvents.add(typed.id)
            if (seenEvents.size > 5_000) seenEvents.clear()
          }
          const data = typed.data ?? {}
          const sessionID = data.sessionID
          if (!sessionID) continue
          const err = data.error ?? {}
          if (type === "session.execution.interrupted") {
            // A manual interrupt stops the auto-retry loop.
            if (cycles.size) dbg(`${PLUGIN} interrupted by user, stopping loop for ${sessionID}`)
            cycles.delete(sessionID)
            continue
          }
          if (type === "session.execution.succeeded") {
            cycles.delete(sessionID)
            continue
          }
          if (!retryable(err.type, err.message)) {
            // Not a connectivity/transient problem: clear the counter, do not re-send.
            if (cycles.size) {
              dbg(`${PLUGIN} terminal failure type=${err.type ?? "?"}, not re-prompting ${sessionID}`)
              cycles.delete(sessionID)
            }
            continue
          }
          if (existsSync(PAUSE_FILE)) {
            dbg(`${PLUGIN} paused via ${PAUSE_FILE}, not re-prompting ${sessionID}`)
            cycles.delete(sessionID)
            continue
          }
          dbg(`${PLUGIN} final retryable failure for ${sessionID}: type=${err.type ?? "?"} message=${(err.message ?? "").slice(0, 120)}`)

          const attempts = (cycles.get(sessionID) ?? 0) + 1
          if (attempts > MAX_REPROMPTS) {
            dbg(`${PLUGIN} giving up after ${MAX_REPROMPTS} re-prompt cycles for ${sessionID}`)
            cycles.delete(sessionID)
            continue
          }
          cycles.set(sessionID, attempts)

          // Re-submit the last user message of the failed execution.
          // Context entries come flat: {id, time, text, files, agents, type:"user"}
          const messages = await ctx.session.context({ sessionID })
          let target: { text: string; files?: unknown[] } | undefined
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i] as unknown as {
              type?: string
              info?: { type?: string; parts?: Array<{ type: string; text?: string }> }
              text?: string
              files?: Array<{ uri?: string }>
            }
            const kind = m.info?.type ?? m.type
            if (kind !== "user") continue
            let text: string | undefined
            if (typeof m.text === "string" && m.text.trim()) text = m.text
            if (!text && Array.isArray(m.info?.parts)) {
              text = m.info.parts.find((p) => p.type === "text" && typeof p.text === "string")?.text
            }
            if (!text) continue
            target = { text, files: Array.isArray(m.files) && m.files.length ? m.files : undefined }
            break
          }
          if (!target) {
            dbg(`${PLUGIN} no user message with text found for ${sessionID}, not re-prompting`)
            cycles.delete(sessionID)
            continue
          }
          const { text, files } = target
          dbg(`${PLUGIN} re-prompt scheduled for ${sessionID} in ${DELAY}ms (auto retry #${attempts}, files=${files?.length ?? 0})`)
          setTimeout(() => {
            void ctx.session
              .prompt({ sessionID, text, files, delivery: "queue" })
              .catch((err2: unknown) => {
                cycles.delete(sessionID)
                dbg(`${PLUGIN} re-prompt failed: ${err2 instanceof Error ? err2.message : String(err2)}`)
              })
          }, DELAY)
        } catch (err) {
          dbg(`${PLUGIN} event handling failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })()

    return () => {
      if (g.__netzRetryLoop === controller) delete g.__netzRetryLoop
      controller.abort()
    }
  },
})
