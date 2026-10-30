import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"

// Matches DNS/connectivity failures so the request can be retried.
const NETWORK =
  /getaddrinfo|EAI_AGAIN|EAI_FAIL|ENOTFOUND|ETIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|fetch failed|network error|terminated/i

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

interface ExecutionData {
  sessionID?: string
  error?: { type?: string; message?: string }
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

    // 1) In-request retries: make network errors retryable for the nvidia
    // provider. The built-in attempt cap still applies inside one request, but
    // this ensures transport/DNS failures use every available attempt.
    await ctx.session.hook("retry", (event) => {
      if (event.model.providerID !== "nvidia") return
      const blob = `${event.error.type} ${event.error.message}`
      if (!NETWORK.test(blob)) return
      // Prefer the user-configured delay; otherwise exponential backoff 5s → 20s.
      const delay = options.delay
        ? Math.max(1_000, options.delay)
        : Math.min(20_000, 5_000 * event.attempt)
      dbg(`${PLUGIN} network failure on attempt ${event.attempt}, retry in ${delay}ms (${event.error.type})`)
      event.decision = { retry: true, delay }
    })

    if (!REPROMPT) return

    // 2) Final-failure recovery: when a request still dies on a network error
    // (the in-request cap was exhausted), wait DELAY and re-submit the last
    // user prompt of that session until it succeeds or the user interrupts.
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
          const typed = event as { id?: string; type?: string; data?: ExecutionData }
          const type = typed.type ?? ""
          if (
            type !== "session.execution.failed" &&
            type !== "session.execution.interrupted" &&
            type !== "session.execution.succeeded"
          ) {
            continue
          }
          // Both step.failed and execution.failed are delivered per failure;
          // process each physical event once only.
          if (typed.id && seenEvents.has(typed.id)) continue
          if (typed.id) {
            seenEvents.add(typed.id)
            if (seenEvents.size > 5_000) seenEvents.clear()
          }
          const data = typed.data ?? {}
          const sessionID = data.sessionID
          if (!sessionID) continue
          const errorText = `[${(data.error?.type ?? "")}]\n${data.error?.message ?? ""}`
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
          if (!NETWORK.test(errorText)) {
            // Not a connectivity problem: clear the counter, do not re-send.
            if (cycles.size && data.error?.type !== "provider.auth") {
              dbg(`${PLUGIN} non-network failure type=${data.error?.type ?? "?"}, not re-prompting ${sessionID}`)
            }
            cycles.delete(sessionID)
            continue
          }
          dbg(`${PLUGIN} final network failure for ${sessionID}: ${errorText.slice(0, 150)}`)

          const attempts = (cycles.get(sessionID) ?? 0) + 1
          if (attempts > MAX_REPROMPTS) {
            dbg(`${PLUGIN} giving up after ${MAX_REPROMPTS} re-prompt cycles for ${sessionID}`)
            cycles.delete(sessionID)
            continue
          }
          cycles.set(sessionID, attempts)

          // Re-submit the last user message of the failed execution.
          const messages = await ctx.session.context({ sessionID })
          for (let i = messages.length - 1; i >= 0; i--) {
            const info = messages[i] as {
              info?: { role?: string; parts?: Array<{ type: string; text?: string }> }
              role?: string
              parts?: Array<{ type: string; text?: string }>
            }
            const role = info.info?.role ?? info.role
            if (role !== "user") continue
            const parts = info.info?.parts ?? info.parts ?? []
            const text = parts.find((p) => p.type === "text" && typeof p.text === "string")?.text
            if (!text) break
            setTimeout(() => {
              void ctx.session
                .prompt({ sessionID, text, delivery: "queue" })
                .catch((err: unknown) => {
                  cycles.delete(sessionID)
                  dbg(`${PLUGIN} re-prompt failed: ${err instanceof Error ? err.message : String(err)}`)
                })
            }, DELAY)
            dbg(`${PLUGIN} re-prompt scheduled for ${sessionID} in ${DELAY}ms (auto retry #${attempts})`)
            break
          }
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
