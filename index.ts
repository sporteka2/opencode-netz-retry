import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync, existsSync } from "node:fs"

// Failures worth retrying: DNS/connectivity problems plus transient HTTP
// errors from the provider (429, 502/503/504 and "Internal server error").
// Deliberately excludes auth and validation errors: those never succeed on
// retry and would just hammer a working credential.
const NETWORK_MESSAGE =
  /getaddrinfo|EAI_AGAIN|EAI_FAIL|ENOTFOUND|ETIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|fetch failed|network error|terminated|internal server error|bad gateway|service unavailable|gateway timeout|overloaded|too many requests|rate limit/i
const NETWORK_TYPE = /^(provider\.(transport|too_many_requests|overloaded|server_error|rate_limit)|APIError)$/

// Provider-side moderation rejection: the whole request (history + prompt) is
// refused. Retrying the same input never succeeds; only a clean context helps.
const SAFETY = /content safety screening|safety (?:filter|screening|system)|moderation|harmful content|flagged content|content policy/i

// External CLI constraint surfaced through a failed step: too many images in
// one model/CLI call. Recoverable by batching on the next attempt.
const IMAGES_LIMIT = /at most \d+ image|limit-mm-per-prompt/i

const IMAGES_HINT =
  "\n\n[автоподсказка] Внешний CLI принимает максимум 8 изображений в одном запросе — разбей на батчи по 8 и суммируй результаты. Ошибку 'At most 8 image(s)' не повторяй."

type FailureKind = "network" | "safety" | "images" | "unknown"

function retryable(type?: string, message?: string): boolean {
  return NETWORK_MESSAGE.test(message ?? "") || NETWORK_TYPE.test(type ?? "")
}

function classify(type?: string, message?: string): FailureKind {
  const blob = `${type ?? ""}\n${message ?? ""}`
  if (SAFETY.test(blob)) return "safety"
  if (IMAGES_LIMIT.test(blob)) return "images"
  if (retryable(type, message)) return "network"
  return "unknown"
}

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "…" : s)

// Presence of this file pauses every automatic recovery immediately.
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

interface FailureEventData {
  sessionID?: string
  error?: { type?: string; message?: string; status?: number }
}

interface Ctx {
  session?: {
    context(input: { sessionID: string }): Promise<readonly unknown[]>
    get(input: { sessionID: string }): Promise<{
      model?: { providerID?: string; id?: string }
      info?: { model?: { providerID?: string; id?: string } }
    }>
    create(input: { directory?: string; title?: string }): Promise<{
      id?: string
      info?: { id?: string }
    }>
    prompt(input: {
      sessionID: string
      text: string
      files?: unknown[]
      model?: { providerID: string; id: string }
      delivery?: "queue" | "steer"
    }): Promise<unknown>
  }
  location?: { directory?: string }
}

/** Flat context entries: {id, time, text, files, agents, type:"user"} */
function findLastUser(messages: readonly unknown[]): { text: string; files?: unknown[] } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
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
    return { text, files: Array.isArray(m.files) && m.files.length ? m.files : undefined }
  }
  return undefined
}

export default Plugin.define({
  id: "netz-retry",
  async setup(ctx) {
    const api = ctx as unknown as Ctx
    const options = (ctx.options as { reprompt?: boolean; delay?: number } | undefined) ?? {}
    const REPROMPT = options.reprompt !== false
    const DELAY = Math.max(1_000, options.delay ?? 10_000)
    // Safety valves: re-prompt cycles per session, and clean-context recoveries.
    const MAX_REPROMPTS = 120
    const MAX_RECOVERIES = 3

    // Per-session counters and dedupe of execution-failure events (the stream
    // can deliver one event twice).
    const cycles = new Map<string, number>()
    const recoveries = new Map<string, number>()
    const seenEvents = new Set<string>()

    // 1) In-request retries: make network/transient errors retryable for the
    // nvidia provider. The built-in attempt cap still applies inside one
    // request, but this ensures those failures use that whole budget.
    await ctx.session.hook("retry", (event) => {
      if (event.model.providerID !== "nvidia") return
      if (classify(event.error.type, event.error.message) !== "network") return
      const delay = options.delay
        ? Math.max(1_000, options.delay)
        : Math.min(20_000, 5_000 * event.attempt)
      dbg(`${PLUGIN} network failure on attempt ${event.attempt}, retry in ${delay}ms (type=${event.error.type})`)
      event.decision = { retry: true, delay }
    })

    if (!REPROMPT) return

    /**
     * Safety rejections refuse the whole request (history + prompt), so the
     * only automatic remedy is a clean session: extract a short sanitized
     * context from the failed session and continue the task there.
     */
    async function recoverIntoCleanSession(
      sessionID: string,
      directory: string | undefined,
      reason: string,
    ): Promise<void> {
      const messages = await api.session!.context({ sessionID })
      const users = messages
        .map((m) => m as { type?: string; info?: { type?: string }; text?: string })
        .filter((m) => (m.info?.type ?? m.type) === "user")
        .slice(-3)
      const excerpts = users
        .map((u, i) => `[${i + 1}] ${truncate(String(u.text ?? ""), 600)}`)
        .join("\n\n")
      const last = users.length ? String(users[users.length - 1].text ?? "") : ""
      const preamble = [
        "Автовосстановление: предыдущая сессия была остановлена провайдером",
        `(«${truncate(reason, 120)}»). Накопленная история отфильтрована модерацией,`,
        "поэтому контекст намеренно очищен. Ниже — краткие выдержки последних",
        "пользовательских сообщений. Продолжи задачу, при необходимости уточни.",
        "",
        excerpts || "(выдержек нет)",
        "",
        "Последнее задание пользователя:",
        last || "(пусто)",
      ].join("\n")

      const info = await api.session!.get({ sessionID })
      const model = info?.model ?? info?.info?.model
      const created = await api.session!.create({
        directory: directory ?? api.location?.directory,
        title: `auto-recovery from ${sessionID.slice(4)}`,
      })
      const newID = created?.id ?? created?.info?.id
      if (!newID) throw new Error("session.create returned no id")
      await api.session!.prompt({
        sessionID: newID,
        text: preamble,
        model: model?.providerID && model?.id ? { providerID: model.providerID, id: model.id } : undefined,
        delivery: "queue",
      })
      dbg(`${PLUGIN} safety recovery: ${sessionID} → new session ${newID} (dir=${directory ?? api.location?.directory})`)
    }

    // 2) Final-failure recovery per failure class. Network failures re-prompt
    // the last user message; safety failures restart in a clean session; the
    // images limit re-prompts once with a batching hint.
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
          const typed = event as {
            id?: string
            type?: string
            data?: FailureEventData & { error?: { type?: string; message?: string } }
            properties?: FailureEventData
            location?: { directory?: string }
          }
          const type = typed.type ?? ""
          if (type.includes("failed")) {
            dbg(`${PLUGIN} raw failed event: ${JSON.stringify(event).slice(0, 500)}`)
          }
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
          const data = (typed.data ?? typed.properties) ?? {}
          const sessionID = data.sessionID
          if (!sessionID) continue
          if (type === "session.execution.interrupted") {
            if (cycles.size) dbg(`${PLUGIN} interrupted by user, stopping loop for ${sessionID}`)
            cycles.delete(sessionID)
            continue
          }
          if (type === "session.execution.succeeded") {
            cycles.delete(sessionID)
            continue
          }
          const err = data.error ?? {}
          const kind = classify(err.type, err.message)
          if (kind === "unknown") {
            if (cycles.size) {
              dbg(`${PLUGIN} terminal failure type=${err.type ?? "?"}: ${truncate(err.message ?? "", 100)} — not re-prompting ${sessionID}`)
              cycles.delete(sessionID)
            }
            continue
          }
          if (existsSync(PAUSE_FILE)) {
            dbg(`${PLUGIN} paused via ${PAUSE_FILE}, not recovering ${sessionID}`)
            cycles.delete(sessionID)
            continue
          }
          if (kind === "safety") {
            const n = (recoveries.get(sessionID) ?? 0) + 1
            recoveries.set(sessionID, n)
            cycles.delete(sessionID)
            if (n > MAX_RECOVERIES) {
              dbg(`${PLUGIN} giving up after ${MAX_RECOVERIES} clean-session recoveries for ${sessionID}`)
              recoveries.delete(sessionID)
              continue
            }
            dbg(`${PLUGIN} content-safety rejection for ${sessionID}; starting clean-session recovery #${n}`)
            void recoverIntoCleanSession(sessionID, typed.location?.directory, err.message ?? "content safety screening").catch(
              (e: unknown) => {
                dbg(`${PLUGIN} recovery failed for ${sessionID}: ${e instanceof Error ? e.message : String(e)}`)
              },
            )
            continue
          }

          const attempts = (cycles.get(sessionID) ?? 0) + 1
          if (attempts > MAX_REPROMPTS) {
            dbg(`${PLUGIN} giving up after ${MAX_REPROMPTS} re-prompt cycles for ${sessionID}`)
            cycles.delete(sessionID)
            continue
          }
          cycles.set(sessionID, attempts)

          const messages = await api.session!.context({ sessionID })
          const target = findLastUser(messages)
          if (!target) {
            dbg(`${PLUGIN} no user message with text found for ${sessionID}, not re-prompting`)
            cycles.delete(sessionID)
            continue
          }
          if (kind === "images") {
            if (attempts > 2) {
              dbg(`${PLUGIN} images-limit persists after 2 hint retries for ${sessionID}, giving up`)
              cycles.delete(sessionID)
              continue
            }
            dbg(`${PLUGIN} images-limit failure for ${sessionID}; re-prompting with batching hint #${attempts}`)
            setTimeout(() => {
              void api.session!
                .prompt({ sessionID: sessionID, text: target.text + IMAGES_HINT, files: target.files, delivery: "queue" })
                .catch((e: unknown) => {
                  cycles.delete(sessionID)
                  dbg(`${PLUGIN} re-prompt failed: ${e instanceof Error ? e.message : String(e)}`)
                })
            }, DELAY)
            continue
          }
          dbg(`${PLUGIN} final network failure for ${sessionID}: type=${err.type ?? "?"} message=${truncate(err.message ?? "", 120)}`)
          dbg(`${PLUGIN} re-prompt scheduled for ${sessionID} in ${DELAY}ms (auto retry #${attempts}, files=${target.files?.length ?? 0})`)
          setTimeout(() => {
            void api.session!
              .prompt({ sessionID, text: target.text, files: target.files, delivery: "queue" })
              .catch((e: unknown) => {
                cycles.delete(sessionID)
                dbg(`${PLUGIN} re-prompt failed: ${e instanceof Error ? e.message : String(e)}`)
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