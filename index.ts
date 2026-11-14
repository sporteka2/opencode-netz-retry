import { Plugin } from "@opencode/plugin"
import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs"

// Failures worth retrying in-request: DNS/connectivity plus transient HTTP
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

// Deterministic provider-side errors that a different provider route avoids:
// NVIDIA "functions" that do not exist for the account, and gateway billing.
const PROVIDER_404 =
  /Function id .* not found|Specified function in account .* is not found|functions? .* (?:not found|not available)/i
const GATEWAY = /credit card|AI Gateway requires|billing|payment required|insufficient (?:quota|credits)/i

const IMAGES_HINT =
  "\n\n[автоподсказка] Внешний CLI принимает максимум 8 изображений в одном запросе — разбей на батчи по 8 и суммируй результаты. Ошибку 'At most 8 image(s)' не повторяй."

type FailureKind = "network" | "safety" | "images" | "switch" | "unknown"

function retryable(type?: string, message?: string): boolean {
  return NETWORK_MESSAGE.test(message ?? "") || NETWORK_TYPE.test(type ?? "")
}

function classify(type?: string, message?: string): FailureKind {
  const blob = `${type ?? ""}\n${message ?? ""}`
  if (SAFETY.test(blob)) return "safety"
  if (IMAGES_LIMIT.test(blob)) return "images"
  if (PROVIDER_404.test(blob) || GATEWAY.test(blob)) return "switch"
  if (retryable(type, message)) return "network"
  return "unknown"
}

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "…" : s)

// Presence of this file pauses every automatic recovery immediately.
const PAUSE_FILE = "/tmp/opencode/netz-retry-paused"
// Session IDs (one per line, matched by substring) that automatic recovery
// must leave alone — e.g. a session deliberately abandoned after its work
// moved to a continuation.
const EXCLUDE_FILE = "/tmp/opencode/netz-retry-exclude.txt"

function excluded(sessionID: string): boolean {
  try {
    const raw = readFileSync(EXCLUDE_FILE, "utf8")
    return raw.split("\n").some((l) => l.trim() && sessionID.includes(l.trim()))
  } catch {
    return false
  }
}

const PLUGIN = "[netz-retry]"
const DEBUG = "/tmp/opencode/netz-retry-debug.log"
const CHAIN_FILE = "/tmp/opencode/netz-retry-chain.json"
const LOCK_DIR = "/tmp/opencode/netz-retry-locks"

/** Cross-restart recovery-chain state, so reloading the plugin cannot reset
 *  the budget of a chain that is already three sessions deep. */
function loadChain(): {
  createdBy: Record<string, string>
  depth: Record<string, number>
  scan: Record<string, number>
} {
  try {
    const raw = readFileSync(CHAIN_FILE, "utf8")
    const parsed = JSON.parse(raw) as {
      createdBy?: Record<string, string>
      depth?: Record<string, number>
      scan?: Record<string, number>
    }
    return { createdBy: parsed.createdBy ?? {}, depth: parsed.depth ?? {}, scan: parsed.scan ?? {} }
  } catch {
    return { createdBy: {}, depth: {}, scan: {} }
  }
}
function saveChain(createdBy: Map<string, string>, depth: Map<string, number>, scan?: Map<string, number>): void {
  try {
    mkdirSync("/tmp/opencode", { recursive: true })
    writeFileSync(
      CHAIN_FILE,
      JSON.stringify({
        createdBy: Object.fromEntries(createdBy),
        depth: Object.fromEntries(depth),
        scan: scan ? Object.fromEntries(scan) : undefined,
      }),
    )
  } catch { /* persistence is best-effort */ }
}
/** Atomic per-session action lock: prevents two plugin instances (per-location
 *  runtimes) from recovering the same session at the same time. */
function lockSession(sessionID: string): boolean {
  try {
    mkdirSync(LOCK_DIR, { recursive: true })
    writeFileSync(`${LOCK_DIR}/${sessionID}`, String(Date.now()), { flag: "wx" })
    return true
  } catch {
    return false
  }
}
function releaseLock(sessionID: string): void {
  try {
    unlinkSync(`${LOCK_DIR}/${sessionID}`)
  } catch { /* already gone */ }
}
function sweepLocks(): void {
  try {
    for (const f of readdirSync(LOCK_DIR) as string[]) {
      const p = `${LOCK_DIR}/${f}`
      try {
        if (Date.now() - Number(readFileSync(p, "utf8")) > 5 * 60_000) unlinkSync(p)
      } catch { /* ignore */ }
    }
  } catch { /* no locks yet */ }
}

function dbg(line: string): void {
  try {
    mkdirSync("/tmp/opencode", { recursive: true })
    appendFileSync(DEBUG, `${new Date().toISOString()} ${line}\n`)
  } catch (err) {
    console.log(`${PLUGIN} fs-debug unavailable:`, err instanceof Error ? err.message : err)
  }
}

interface ErrShape {
  type?: string
  message?: string
}

interface SessionInfoLite {
  id?: string
  info?: { id?: string; title?: string; time?: { updated?: number; created?: number } }
  title?: string
  time?: { updated?: number; created?: number }
}

interface Ctx {
  session?: {
    context(input: { sessionID: string }): Promise<readonly unknown[]>
    get(input: { sessionID: string }): Promise<{
      model?: { providerID?: string; id?: string }
      info?: { model?: { providerID?: string; id?: string } }
    }>
    list(input: { directory?: string; limit?: number }): Promise<{
      data?: SessionInfoLite[]
      info?: SessionInfoLite[]
    }>
    create(input: { directory?: string; title?: string }): Promise<{ id?: string; info?: { id?: string } }>
    prompt(input: {
      sessionID: string
      text: string
      files?: unknown[]
      model?: { providerID: string; id: string }
      delivery?: "queue" | "steer"
    }): Promise<unknown>
    switchModel(input: {
      sessionID: string
      model: { providerID: string; id: string }
    }): Promise<unknown>
    interrupt(input: { sessionID: string }): Promise<{ interrupted?: boolean }>
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
    const options = (ctx.options as
      | {
          reprompt?: boolean
          delay?: number
          scanMs?: number
          fallback?: Array<{ providerID: string; id: string }>
          stuckMs?: number
        }
      | undefined) ?? {}
    const REPROMPT = options.reprompt !== false
    const DELAY = Math.max(1_000, options.delay ?? 10_000)
    const SCAN_MS = Math.max(60_000, options.scanMs ?? 180_000)
    // A step silent for this long is treated as hung (headerTimeout:false
    // means a dead socket never errors by itself).
    const STUCK_MS = Math.max(120_000, options.stuckMs ?? 600_000)
    // Provider to switch to when the current route fails deterministically
    // (missing NVIDIA "functions", gateway without billing, ...).
    const FALLBACK: Array<{ providerID: string; id: string }> =
      options.fallback && options.fallback.length
        ? options.fallback
        : [{ providerID: "cloudflare-workers-ai", id: "@cf/zai-org/glm-4.7-flash" }]
    // Safety valves.
    const MAX_REPROMPTS = 120
    const MAX_RECOVERIES = 3
    // Depth of automatic recovery chains (a recovery of a recovery of ...).
    const MAX_CHAIN = 3

    // child → origin: recovery sessions count toward the origin's budget so
    // a failing session cannot spawn recoveries indefinitely.
    const createdBy = new Map<string, string>()
    const chainDepth = new Map<string, number>()
    {
      const persisted = loadChain()
      for (const [k, v] of Object.entries(persisted.createdBy)) createdBy.set(k, v)
      for (const [k, v] of Object.entries(persisted.depth)) chainDepth.set(k, v)
    }
    // Last observed failure kind + raw error per session, so the scan can
    // classify a failed marker it has no error text for.
    const knownKind = new Map<string, FailureKind>()
    const rememberedErr = new Map<string, ErrShape>()
    const originOf = (id: string): string => {
      let cur = id
      for (let i = 0; i < MAX_CHAIN + 2; i++) {
        const parent = createdBy.get(cur)
        if (!parent) break
        cur = parent
      }
      return cur
    }

    const cycles = new Map<string, number>()
    const recoveries = new Map<string, number>()
    const switches = new Map<string, number>()
    const failedAt = new Map<string, number>()
    const seenEvents = new Set<string>()
    // Known project directories, overridable via the `directories` option. The
    // globalThis guard keeps a single plugin instance, so its seed list must
    // cover every location that hosts sessions.
    const DEFAULT_DIRS = [
      api.location?.directory,
      "/home/user",
      "/home/user/Desktop/quran",
      "/home/user/Desktop/themes",
      "/home/user/media-server",
    ].filter((d): d is string => typeof d === "string" && d.length > 0)
    const dirs = new Set<string>((options as { directories?: string[] }).directories ?? DEFAULT_DIRS)

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

    const paused = (): boolean => existsSync(PAUSE_FILE)

    /** Safety rejections refuse the whole request; continue in a clean session. */
    async function recoverIntoCleanSession(
      sessionID: string,
      directory: string | undefined,
      reason: string,
      attempt = 1,
    ): Promise<void> {
      const messages = await api.session!.context({ sessionID })
      const users = messages
        .map((m) => m as { type?: string; info?: { type?: string }; text?: string })
        .filter((m) => (m.info?.type ?? m.type) === "user")
        .slice(-3)
      const excerpts = users.map((u, i) => `[${i + 1}] ${truncate(String(u.text ?? ""), 600)}`).join("\n\n")
      const last = users.length ? String(users[users.length - 1].text ?? "") : ""
      // Second and later attempts send a minimal preamble: carrying excerpts
      // again would just reproduce the filtered content. For these tasks the
      // real state lives in the repository, so a clean restart can rediscover
      // it from files.
      const preamble =
        attempt >= 2
          ? [
              "Автовосстановление: предыдущая сессия снова была остановлена провайдером",
              `(«${truncate(reason, 120)}»). Контекст намеренно минимален.`,
              "Определи текущее состояние задачи по файлам проекта (git status,",
              "git log, README, скрипты), кратко опиши его и продолжи работу.",
              "Если нужно решение пользователя — задай вопрос.",
            ].join("\n")
          : [
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
      const dir = directory ?? api.location?.directory
      const created = await api.session!.create({ directory: dir, title: `auto-recovery from ${sessionID.slice(4)}` })
      const newID = created?.id ?? created?.info?.id
      if (!newID) throw new Error("session.create returned no id")
      createdBy.set(newID, sessionID)
      chainDepth.set(newID, (chainDepth.get(sessionID) ?? 0) + 1)
      saveChain(createdBy, chainDepth)
      await api.session!.prompt({ sessionID: newID, text: preamble, delivery: "queue" })
      dbg(`${PLUGIN} safety recovery: ${sessionID} → ${newID} (dir=${dir}, depth=${chainDepth.get(newID)})`)
    }

    /** Switch the session to a working provider route and re-prompt the last
     *  user message — for deterministic provider errors (missing functions,
     *  billing) where the current route will keep failing. */
    async function switchAndRetry(sessionID: string, reason: string): Promise<void> {
      const messages = await api.session!.context({ sessionID })
      const target = findLastUser(messages)
      if (!target) {
        dbg(`${PLUGIN} switch recovery: no user message for ${sessionID}`)
        return
      }
      let n = (switches.get(sessionID) ?? 0) + 1
      if (n > FALLBACK.length) {
        dbg(`${PLUGIN} switch recovery: exhausted ${FALLBACK.length} fallback routes for ${sessionID}`)
        switches.delete(sessionID)
        return
      }
      const model = FALLBACK[Math.min(n - 1, FALLBACK.length - 1)]
      const info = await api.session!.get({ sessionID })
      const current = info?.model ?? info?.info?.model
      if (current?.providerID === model.providerID && current?.id === model.id && n < FALLBACK.length) n++
      const route = FALLBACK[Math.min(n - 1, FALLBACK.length - 1)]
      switches.set(sessionID, n)
      try {
        await api.session!.switchModel({ sessionID, model: route })
      } catch {
        dbg(`${PLUGIN} switch recovery: switchModel failed for ${sessionID}, retrying with prompt model`)
      }
      dbg(`${PLUGIN} deterministic provider failure (${truncate(reason, 80)}): switching ${sessionID} to ${route.providerID}/${route.id} and re-prompting`)
      setTimeout(() => {
        void api
          .session!.prompt({
            sessionID,
            text: `${target.text}\n\n[автоподсказка] Предыдущая попытка упала на ошибке «${truncate(reason, 120)}» — продолжай задачу, обойдя проблему.`,
            files: target.files,
            delivery: "queue",
          })
          .catch((e: unknown) => {
            switches.delete(sessionID)
            dbg(`${PLUGIN} switch recovery failed: ${e instanceof Error ? e.message : String(e)}`)
          })
      }, DELAY)
    }

    /** Shared recovery dispatch for both live events and the watchdog scan.
     *  The scan cannot classify (failed markers carry no error text), so it
     *  uses one conservative re-prompt per attempt, capped per session. */
    const scanAttempts = new Map<string, number>()
    for (const [k, v] of Object.entries(loadChain().scan)) scanAttempts.set(k, v)
    const stuckAttempts = new Map<string, number>()
    async function handleFailureLocked(
      sessionID: string,
      err: ErrShape,
      directory: string | undefined,
      fromScan = false,
    ): Promise<void> {
      let kind = classify(err.type, err.message)
      if (kind !== "unknown") {
        knownKind.set(sessionID, kind)
        rememberedErr.set(sessionID, err)
      }
      if (fromScan && kind === "unknown") {
        const n = (scanAttempts.get(sessionID) ?? 0) + 1
        scanAttempts.set(sessionID, n)
        saveChain(createdBy, chainDepth, scanAttempts)
        if (n > 2) {
          dbg(`${PLUGIN} scan: ${sessionID} still failing after 2 attempts — needs manual review`)
          return
        }
        dbg(`${PLUGIN} scan: unclassified failure in ${sessionID}, conservative re-prompt #${n}`)
        const messages = await api.session!.context({ sessionID })
        const target = findLastUser(messages)
        if (!target) return
        setTimeout(() => {
          void api.session!
            .prompt({
              sessionID,
              text: `${target.text}\n\n[автоподсказка] Предыдущая попытка не завершилась. Продолжи задачу.`,
              files: target.files,
              delivery: "queue",
            })
            .catch((e: unknown) => dbg(`${PLUGIN} scan re-prompt failed: ${e instanceof Error ? e.message : String(e)}`))
        }, DELAY)
        return
      }
      const reason = `${err.type ?? "?"}: ${truncate(err.message ?? "", 100)}`
      switch (kind) {
        case "safety": {
          const origin = originOf(sessionID)
          const n = (recoveries.get(origin) ?? 0) + 1
          recoveries.set(origin, n)
          cycles.delete(sessionID)
          if ((chainDepth.get(sessionID) ?? 0) >= MAX_CHAIN || n > MAX_RECOVERIES) {
            dbg(`${PLUGIN} giving up on ${sessionID} (chain depth ${chainDepth.get(sessionID) ?? 0}, recoveries ${n} of ${MAX_RECOVERIES} for origin ${origin})`)
            return
          }
          dbg(`${PLUGIN} content-safety rejection for ${sessionID}; clean-session recovery #${n} (origin ${origin})`)
          await recoverIntoCleanSession(sessionID, directory, reason, n).catch((e: unknown) =>
            dbg(`${PLUGIN} safety recovery failed for ${sessionID}: ${e instanceof Error ? e.message : String(e)}`),
          )
          return
        }
        case "images": {
          const n = (cycles.get(sessionID) ?? 0) + 1
          cycles.set(sessionID, n)
          if (n > 2) {
            dbg(`${PLUGIN} images-limit persists after 2 hint retries for ${sessionID}, giving up`)
            cycles.delete(sessionID)
            return
          }
          const messages = await api.session!.context({ sessionID })
          const target = findLastUser(messages)
          if (!target) return
          dbg(`${PLUGIN} images-limit failure for ${sessionID}; re-prompting with batching hint #${n}`)
          setTimeout(() => {
            void api.session!
              .prompt({ sessionID, text: target.text + IMAGES_HINT, files: target.files, delivery: "queue" })
              .catch((e: unknown) => dbg(`${PLUGIN} images re-prompt failed: ${e instanceof Error ? e.message : String(e)}`))
          }, DELAY)
          return
        }
        case "switch": {
          await switchAndRetry(sessionID, reason)
          return
        }
        case "network": {
          const n = (cycles.get(sessionID) ?? 0) + 1
          cycles.set(sessionID, n)
          if (n > MAX_REPROMPTS) {
            dbg(`${PLUGIN} giving up after ${MAX_REPROMPTS} re-prompt cycles for ${sessionID}`)
            cycles.delete(sessionID)
            return
          }
          const messages = await api.session!.context({ sessionID })
          const target = findLastUser(messages)
          if (!target) return
          dbg(`${PLUGIN} network failure for ${sessionID} (${reason}); re-prompt scheduled in ${DELAY}ms (auto retry #${n}, files=${target.files?.length ?? 0})`)
          setTimeout(() => {
            void api.session!
              .prompt({ sessionID, text: target.text, files: target.files, delivery: "queue" })
              .catch((e: unknown) => {
                cycles.delete(sessionID)
                dbg(`${PLUGIN} re-prompt failed: ${e instanceof Error ? e.message : String(e)}`)
              })
          }, DELAY)
          return
        }
        default:
          dbg(`${PLUGIN} unrecoverable failure for ${sessionID}: ${reason} — logging only`)
      }
    }
    async function handleFailure(
      sessionID: string,
      err: ErrShape,
      directory: string | undefined,
      fromScan = false,
    ): Promise<void> {
      if (paused()) {
        dbg(`${PLUGIN} paused via ${PAUSE_FILE}, not recovering ${sessionID}`)
        return
      }
      if (excluded(sessionID)) {
        dbg(`${PLUGIN} ${sessionID} is in the exclude list, leaving it alone`)
        cycles.delete(sessionID)
        return
      }
      if (!lockSession(sessionID)) {
        dbg(`${PLUGIN} another instance is already recovering ${sessionID}, skipping`)
        return
      }
      try {
        // Bound every recovery: a hung provider call must not hold the lock.
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("recovery timeout")), 60_000),
        )
        await Promise.race([handleFailureLocked(sessionID, err, directory, fromScan), timeout])
      } catch (e) {
        dbg(`${PLUGIN} recovery attempt failed for ${sessionID}: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        releaseLock(sessionID)
      }
    }

    // 2) Event-driven recovery.
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
            data?: { sessionID?: string; error?: ErrShape }
            properties?: { sessionID?: string; error?: ErrShape }
            location?: { directory?: string }
          }
          const type = typed.type ?? ""
          if (type.includes("failed")) {
            dbg(`${PLUGIN} raw failed event: ${JSON.stringify(event).slice(0, 500)}`)
          }
          if (type !== "session.execution.failed") continue
          if (typed.id && seenEvents.has(typed.id)) continue
          if (typed.id) {
            seenEvents.add(typed.id)
            if (seenEvents.size > 5_000) seenEvents.clear()
          }
          const data = typed.data ?? typed.properties ?? {}
          const sessionID = data.sessionID
          if (!sessionID) continue
          if (typed.location?.directory) dirs.add(typed.location.directory)
          if (type === "session.execution.succeeded") {
            cycles.delete(sessionID)
            failedAt.delete(sessionID)
            selfInterrupted.delete(sessionID)
            continue
          }
          if (type === "session.execution.interrupted") {
            if (cycles.size) dbg(`${PLUGIN} interrupted by user, stopping loop for ${sessionID}`)
            cycles.delete(sessionID)
            continue
          }
          await handleFailure(sessionID, data.error ?? {}, typed.location?.directory)
        } catch (err) {
          dbg(`${PLUGIN} event handling failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })()

    // 3) Watchdog: catches failures that never emit an event (server restart,
    //    dead subscription window) by scanning recent sessions periodically.
    // Sessions the plugin interrupted itself: their "interrupted" state needs
    // recovery; a user-initiated interrupt does not.
    const selfInterrupted = new Set<string>()
    const findFailedIdle = (messages: readonly unknown[], sessionID: string): number | undefined => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as {
          type?: string
          info?: { type?: string; outcome?: string; time?: { created?: number } }
          outcome?: string
          time?: { created?: number }
        }
        const outcome = m.outcome ?? m.info?.outcome
        const t = m.time?.created ?? m.info?.time?.created
        // "failed" always; "interrupted" only when the plugin itself interrupted
        // the session (a manual Esc must stop the session for good).
        if (outcome === "failed" || (outcome === "interrupted" && selfInterrupted.has(sessionID))) return t ?? 0
        const kind = m.info?.type ?? m.type
        if (kind === "assistant" || kind === "user" || kind === "compaction") return undefined
      }
      return undefined
    }

    async function scan(): Promise<void> {
      let checked = 0
      let recovered = 0
      sweepLocks()
      // One watchdog at a time: several per-location instances would otherwise
      // all scan all directories every cycle.
      // Lease-style lock: stale (older than a scan cycle) leases are taken over.
      try {
        writeFileSync(`${LOCK_DIR}/watchdog`, String(Date.now()), { flag: "wx" })
      } catch {
        try {
          if (Date.now() - Number(readFileSync(`${LOCK_DIR}/watchdog`, "utf8")) > 90_000) {
            writeFileSync(`${LOCK_DIR}/watchdog`, String(Date.now()))
          } else {
            return
          }
        } catch {
          return
        }
      }
      // One recovery per session per scan pass, even if several directories
      // list the same session.
      const handled = new Set<string>()
      for (const dir of [...dirs]) {
        let list: SessionInfoLite[] = []
        try {
          const page = await api.session!.list({ directory: dir, limit: 40 })
          list = page?.data ?? page?.info ?? []
        } catch (e) {
          dbg(`${PLUGIN} scan: list failed for ${dir}: ${e instanceof Error ? e.message : String(e)}`)
          continue
        }
        for (const s of list) {
          const sessionID = s.id ?? s.info?.id
          if (!sessionID || handled.has(sessionID)) continue
          handled.add(sessionID)
          if (excluded(sessionID)) continue
          const updated = s.time?.updated ?? s.info?.time?.updated
          // Failed sessions are by definition stale, so do not skip them by recency;
          // only skip sessions untouched for a day (abandoned).
          if (updated && Date.now() - updated > 24 * 3600_000) continue
          let messages: readonly unknown[]
          try {
            messages = await api.session!.context({ sessionID })
          } catch {
            continue
          }
          checked++
          const failedTime = findFailedIdle(messages, sessionID)
          if (!failedTime || failedTime <= (failedAt.get(sessionID) ?? 0)) {
            // Hung step (no failure event, no new messages for STUCK_MS):
            // with headerTimeout:false a dead socket waits forever.
            const last = messages[messages.length - 1] as {
              type?: string
              info?: { type?: string }
              time?: { created?: number }
              info2?: unknown
            }
            const lastKind = last?.info?.type ?? last?.type
            const lastAt = last?.time?.created ?? 0
            if ((lastKind === "assistant" || lastKind === "compaction" || lastKind === "user") && lastAt && Date.now() - lastAt > STUCK_MS) {
              const n = (stuckAttempts.get(sessionID) ?? 0) + 1
              stuckAttempts.set(sessionID, n)
              if (n <= 2) {
                dbg(`${PLUGIN} scan: ${sessionID} stuck for ${Math.round((Date.now() - lastAt) / 60000)}min — interrupting and re-prompting (#${n})`)
                void api.session!.interrupt({ sessionID }).catch(() => undefined)
                selfInterrupted.add(sessionID)
                const target = findLastUser(messages)
                if (target) {
                  setTimeout(() => {
                    void api.session!
                      .prompt({
                        sessionID,
                        text: `${target.text}\n\n[автоподсказка] Предыдущий шаг завис и был прерван автоматически. Продолжи задачу.`,
                        files: target.files,
                        delivery: "queue",
                      })
                      .catch((e: unknown) => dbg(`${PLUGIN} stuck re-prompt failed: ${e instanceof Error ? e.message : String(e)}`))
                  }, 5_000)
                }
                recovered++
              }
            }
            continue
          }
          failedAt.set(sessionID, failedTime)
          dbg(`${PLUGIN} scan: new failed state in ${sessionID} at ${new Date(failedTime).toISOString()}`)
          recovered++
          // Reuse the last classified kind for this session when available:
          // the failed marker itself carries no error text.
          const remembered = knownKind.get(sessionID) ?? "unknown"
          dbg(`${PLUGIN} scan: recovering ${sessionID} as "${remembered}" (last known kind)`)
          await handleFailure(sessionID, rememberedErr.get(sessionID) ?? { type: "unknown", message: "" }, dir, remembered === "unknown")
        }
      }
      if (checked || recovered) dbg(`${PLUGIN} scan done: ${checked} sessions checked, ${recovered} recovered`)
      try {
        appendFileSync(
          `${DEBUG}.status`,
          `${new Date().toISOString()} checked=${checked} recovered=${recovered} dirs=${dirs.size} failedTracked=${failedAt.size}\n`,
        )
      } catch { /* status file is best-effort */ }
      try {
        unlinkSync(`${LOCK_DIR}/watchdog`)
      } catch { /* already released */ }
    }

    const scanT = setInterval(() => void scan().catch((e) => dbg(`${PLUGIN} scan failed: ${e instanceof Error ? e.message : String(e)}`)), SCAN_MS)
    dbg(`${PLUGIN} watchdog armed: every ${SCAN_MS}ms over dirs ${[...dirs].join(", ")}`)

    return () => {
      if (g.__netzRetryLoop === controller) delete g.__netzRetryLoop
      controller.abort()
      clearInterval(scanT)
    }
  },
})