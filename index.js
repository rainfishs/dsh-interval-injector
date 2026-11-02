/**
 * interval-injector — 定期把一段文字注入對話歷史的通用注入器。
 *
 * 它不綁任何特定用途：內容完全由 `config.text` 決定。塞角色卡（避免人設漂移）、
 * 塞週期性提醒、塞「請繼續遵守某份規格」的短句，都只是同一支外掛換 text 而已。
 *
 * 骨架沿用官方 `@deepseek-ai/dsh-time-context` 的注入法：在每個「模型開口前」
 * 的步驟（`agent/pre-step` waterfall）於當步訊息尾端補一則 user-role 的 plugin
 * 訊息；註冊時帶 `{ prepend: true }`，讓它排在最靠近模型回答的位置。
 *
 * 這支外掛**不提供任何 service**，是單純的消費端，掛在任何一層的 row 上都行
 * （不需要 isolate realm）。0.2 之後本套件宣告 `dsh.bundle.patch`，安裝後由
 * `cordis.patch.yml` 插一行到 profile 的組合裡。
 *
 * 刻意**零依賴**：外部套件是以 link 方式進 profile 的，從套件真實路徑往上找不到
 * harness 的 node_modules，所以連 `@deepseek-ai/dsh-llm` 的 `createUserMessage`
 * 都不能 import。這裡照它的語意自行建立等價訊息（randomUUID + 遞迴凍結），
 * 讓套件在任何安裝方式下都能直接跑，也不需要任何 build 權限。
 *
 * 0.2 起 `source.kind` 不再有共通的 `plugin`：每個生產者宣告自己的 kind，所以這裡
 * 用 `interval-injector`（與 time-context 用 `time-context` 同一個做法）。
 */

import { randomUUID } from 'node:crypto'

/** Cordis 外掛名稱，同時是訊息 `source.plugin` 的值。 */
export const name = 'interval-injector'

/** 沒寫 config 時用的預設值。 */
const DEFAULTS = {
  /** 每隔幾個進入步驟注入一次。 */
  everyNSteps: 12,
  /** 距上次注入超過幾毫秒就注入一次。 */
  refreshIntervalMs: 600_000,
  /** 收合在對話列上的單行說明。 */
  summary: '定期注入',
}

/**
 * 與 `@deepseek-ai/dsh-llm` 的 `deepFreeze` 同語意：遞迴凍結後才發布。
 * @param value - 任意新建的訊息結構。
 * @returns 同一個物件，已遞迴凍結。
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * 讀一個非負數設定；不是有限數就退回預設值。
 * @param value - row config 給的值。
 * @param fallback - 缺省值。
 * @returns 正規化後的數字（0 = 關掉這個條件）。
 */
function countOf(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * `notice` 形式的 summary 上限：0.2 把這行寫進持久紀錄，長度要有界。
 */
const SUMMARY_MAX_CHARS = 120

/**
 * 掛上 pre-step 監聽；外掛卸載時監聽自動移除。
 * @param ctx - 這個 preset row 的 context（隨 session 卸載）。
 * @param config - row config：`text`（要注入的文字，必填）、`everyNSteps`、
 *   `refreshIntervalMs`、`summary`。
 */
export function apply(ctx, config) {
  const options = config ?? {}
  const text = typeof options.text === 'string' ? options.text.trim() : ''
  // 0.1 的 `ctx.get('logger')` 在 0.2 是 `ctx.logger`；兩者都試，取不到就不記錄。
  const logger = ctx.logger ?? (typeof ctx.get === 'function' ? ctx.get('logger') : undefined)

  if (text === '') {
    logger?.warn?.('interval-injector: config.text 是空的，外掛不作用')
    return
  }

  const everyNSteps = Math.floor(countOf(options.everyNSteps, DEFAULTS.everyNSteps))
  const refreshIntervalMs = countOf(options.refreshIntervalMs, DEFAULTS.refreshIntervalMs)
  const requested = typeof options.summary === 'string' && options.summary !== ''
    ? options.summary
    : DEFAULTS.summary
  const summary = requested.length <= SUMMARY_MAX_CHARS
    ? requested
    : `${requested.slice(0, SUMMARY_MAX_CHARS - 1)}…`

  if (everyNSteps === 0 && refreshIntervalMs === 0) {
    logger?.warn?.('interval-injector: everyNSteps 與 refreshIntervalMs 都是 0，外掛不作用')
    return
  }

  /** agent -> { steps, since }；每個 agent 各自計數，session 結束就回收。 */
  const counters = new WeakMap()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (payload.signal !== undefined && payload.signal.aborted === true) return decision
    // 空回合（沒有要送出的訊息）不硬塞，免得無中生有一個請求。
    if (decision.messages.length === 0) return decision

    const agent = payload.agent
    const now = Date.now()
    let counter = counters.get(agent)
    if (counter === undefined) {
      counter = { steps: 0, since: now }
      counters.set(agent, counter)
    }

    const dueBySteps = everyNSteps > 0 && counter.steps + 1 >= everyNSteps
    const dueByTime = refreshIntervalMs > 0 && now - counter.since >= refreshIntervalMs
    if (!dueBySteps && !dueByTime) {
      counter.steps += 1
      return decision
    }

    counter.steps = 0
    counter.since = now
    const message = deepFreeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: name, form: 'notice', summary },
    })
    return { ...decision, messages: [...decision.messages, message] }
  }, { prepend: true })
}
