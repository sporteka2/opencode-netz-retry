import { Plugin } from "@opencode/plugin"

// Matches DNS/connectivity failures so the request can be retried.
const NETWORK =
  /getaddrinfo|EAI_AGAIN|EAI_FAIL|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|fetch failed|network error|terminated/i

const PLUGIN = "[netz-retry]"

function lastAttempt(session: { attempts: number }): number {
  return session.attempts
}

export default Plugin.define({
  id: "netz-retry",
  async setup(ctx) {
    const options = (ctx.options as { reprompt?: boolean; delay?: number } | undefined) ?? {}
    const REPROMPT = options.reprompt !== false
    const DELAY = Math.max(1_000, options.delay ?? 10_000)
    // Number of re-prompt cycles per session before giving up (safety valve).
    const MAX_REPROMPTS = 120

    // Per-session counter of automatic re-prompt cycles.
    const cycles = new Map<string, number>()

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
      console.log(`${PLUGIN} network failure on attempt ${event.attempt}, retry in ${delay}ms`)
      event.decision = { retry: true, delay }
    })

    if (!REPROMPT) return

    // 2) Final-failure recovery: when a request still dies on a network error
    // (the in-request cap was exhausted), wait DELAY and re-submit the last
    // user prompt of that session until it succeeds or the user interrupts.
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const type = (event as { type?: string }).type ?? ""
          const props =
            (
              event as {
                properties?: {
                  info?: { id?: string }
                  sessionID?: string
                  error?: { type?: string; message?: string }
                }
              }
            ).properties ?? {}
          const sessionID = props.info?.id ?? props.sessionID
          if (!sessionID) continue

          if (type === "session.execution.succeeded" || type === "session.execution.interrupted") {
            // Success or a manual interrupt stops the auto-retry loop.
            cycles.delete(sessionID)
            continue
          }
          if (type !== "session.execution.failed") continue

          const blob = JSON.stringify(props.error ?? {})
          if (!NETWORK.test(blob)) {
            // Not a connectivity problem: clear the counter, do not re-send.
            cycles.delete(sessionID)
            continue
          }

          const attempts = (cycles.get(sessionID) ?? 0) + 1
          if (attempts > MAX_REPROMPTS) {
            console.error(`${PLUGIN} giving up after ${MAX_REPROMPTS} re-prompt cycles for ${sessionID}`)
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
            console.log(`${PLUGIN} re-prompting ${sessionID} (automatic retry #${attempts})`)
            setTimeout(() => {
              void ctx.session
                .prompt({ sessionID, text, delivery: "queue" })
                .catch((err: unknown) => {
                  cycles.delete(sessionID)
                  console.error(`${PLUGIN} re-prompt failed:`, err)
                })
            }, DELAY)
            break
          }
        } catch (err) {
          console.error(`${PLUGIN} event handling failed:`, err)
        }
      }
    })()

    return () => controller.abort()
  },
})
