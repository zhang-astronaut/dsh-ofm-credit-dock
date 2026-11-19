/**
 * OFM credit dock — browser half.
 *
 * Occupies the sidebar's bottom action seat (`sidebar.footer.action`, a
 * root-scoped list rendered directly above the Settings row — the lower-left
 * corner of the shell) and answers four questions at a glance:
 *
 *   1. Which Our Free Model / "EAC router" channels have an account bound?
 *      One row per such channel, using the provider name the picker shows.
 *   2. How much credit is left on each? Read through Our Free Model's own
 *      `/api/channel-pack` RPC (`provider.status` then `credits.balances`) —
 *      the same numbers its settings page shows. Nothing here resolves a
 *      credential or contacts a provider directly.
 *   3. Which channel backs the model in use right now? Highlighted.
 *   4. Is the number still current? It re-reads on a timer, on window focus, and
 *      when another surface announces a channel change.
 *
 * ## Why the provider id is the whole answer
 *
 * Every account channel is registered as its own LLM provider (`trae`,
 * `qodercn`, `zcode`, …), so the current selection's `provider` names the
 * channel outright. No model-name parsing is needed. A selection on
 * `our-free-model` is the free lane rather than an account channel, and then no
 * row is highlighted — correct, because no channel credit is being spent.
 *
 * ## Where the current selection comes from
 *
 * The session list row carries the `modelSelection` projection
 * (`{ lastUsed, next }`); `next` is what the following request uses, which is
 * exactly what the composer's model seat displays. The list is re-published on
 * forwarded control frames, so a model switch re-renders this dock without a
 * reload.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. Colour comes from theme tokens only.
 */
window.__ModuleLoader__.load({
  id: '@zhang-astronaut/ofm-credit-dock',
  factory: require => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'ofmCreditDock'
    const STYLE_ID = '@zhang-astronaut/ofm-credit-dock/CreditDock.module.css'
    const CHANNEL_PACK_ENDPOINT = 'channel-pack'
    /** How often the balance reading refreshes while the page sits open. */
    const BALANCE_REFRESH_MS = 90_000
    /** A click refreshes immediately; ignore rapid repeats. */
    const MANUAL_REFRESH_FLOOR_MS = 4_000
    /** Floor for hint-driven re-reads (focus, `ofm:channels`), which can fire in bursts. */
    const HINT_REFRESH_FLOOR_MS = 15_000

    /**
     * The channels Our Free Model mounts, in the order its own page lists them.
     * `accent` is each provider's brand colour and is used only for the identity
     * dot; every text colour comes from a theme token so both schemes read.
     */
    const CHANNELS = [
      { id: 'lobsterai', name: 'LobsterAI', accent: '#FF6A00' },
      { id: 'qoder', name: 'Qoder', accent: '#615CED' },
      // Upstream display name is "Qoder (中国版)"; kept short so the row fits.
      { id: 'qodercn', name: 'Qoder CN', accent: '#7A6CF0' },
      { id: 'trae', name: 'TRAE', accent: '#00BFA6' },
      { id: 'cline', name: 'Cline', accent: '#5B5BD6' },
      { id: 'loomy', name: 'Loomy', accent: '#2F6BFF' },
      { id: 'raccoon', name: 'Raccoon', accent: '#00A6A6' },
      { id: 'minimax', name: 'MiniMax Code', accent: '#E4007F' },
      { id: 'zcode', name: 'ZCode', accent: '#3B6EF6' },
      { id: 'gemini', name: 'Gemini', accent: '#4285F4' },
    ]
    const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.id, channel]))
    const CHANNEL_ORDER = new Map(CHANNELS.map((channel, index) => [channel.id, index]))

    /**
     * Units whose values are fractions of a whole rather than additive counts.
     *
     * A percentage is a window's used share, and a balance is a mean across
     * windows, so two Gemini accounts cannot be summed into "150 %". They are
     * averaged instead — and, because the number is then an average rather than
     * a total, it is labelled as such.
     */
    const FRACTIONAL_UNITS = new Set(['%', 'percent', 'quota'])

    // ── dictionaries ────────────────────────────────────────────────────────────
    // Flat key → template; `{name}` placeholders are substituted by `format`.
    const zh = {
      'dock.title': 'EAC 额度',
      'dock.collapse': '收起额度面板',
      'dock.expand': '展开额度面板',
      'dock.refresh': '刷新额度',
      'dock.refreshing': '正在刷新额度…',
      'dock.providers': '{n} 个厂家',
      'dock.empty': '还没有绑定任何 EAC router 账号',
      'dock.emptyHint': '到 Our Free Model 的「EAC router」页登录一个厂家，这里就会出现它的额度。',
      'dock.noConnection': '当前页面没有可用的连接通道，读不到额度。',
      'dock.unavailable': 'Our Free Model 未安装或未启用，读不到渠道数据。',
      'dock.loading': '正在读取额度…',
      'dock.unknown': '—',
      'dock.queryFailed': '查询失败',
      'dock.inUse': '使用中',
      'dock.inUseHint': '当前会话正在使用这个厂家的模型',
      'dock.updated': '更新于 {when}',
      'dock.updatedJustNow': '刚刚',
      'dock.minutesAgo': '{n} 分钟前',
      'dock.hoursAgo': '{n} 小时前',
      'dock.updatedNever': '尚未读取',
      'dock.partial': '{n} 个账号未能查询余额',
      'dock.averaged': '多个账号取平均',
      'dock.errorDetail': '原因：{reason}',
      'dock.unit.credit': '积分',
      'dock.unit.tokens': 'Token',
      'dock.unit.dollars': 'USD',
      'dock.unit.quota': '%',
      'dock.unit.points': '积分',
    }
    const en = {
      'dock.title': 'EAC credits',
      'dock.collapse': 'Collapse the credit panel',
      'dock.expand': 'Expand the credit panel',
      'dock.refresh': 'Refresh credits',
      'dock.refreshing': 'Refreshing credits…',
      'dock.providers': '{n} providers',
      'dock.empty': 'No EAC router channel is connected yet',
      'dock.emptyHint': 'Sign in to a provider on Our Free Model’s “EAC router” page and its credit appears here.',
      'dock.noConnection': 'This page has no usable connection channel, so credits cannot be read.',
      'dock.unavailable': 'Our Free Model is not installed or not enabled, so there are no channels to read.',
      'dock.loading': 'Reading credits…',
      'dock.unknown': '—',
      'dock.queryFailed': 'Query failed',
      'dock.inUse': 'In use',
      'dock.inUseHint': 'The current session uses a model from this provider',
      'dock.updated': 'Updated {when}',
      'dock.updatedJustNow': 'just now',
      'dock.minutesAgo': '{n}m ago',
      'dock.hoursAgo': '{n}h ago',
      'dock.updatedNever': 'Not read yet',
      'dock.partial': '{n} accounts could not be read',
      'dock.averaged': 'averaged across accounts',
      'dock.errorDetail': 'Reason: {reason}',
      'dock.unit.credit': 'credits',
      'dock.unit.tokens': 'tokens',
      'dock.unit.dollars': 'USD',
      'dock.unit.quota': '%',
      'dock.unit.points': 'points',
    }
    const DICTS = { zh, en }

    /** Substitute `{name}` placeholders; unknown keys render as the key. */
    function format(text, vars) {
      if (vars === undefined) return text
      return text.replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match)
    }

    // ── number and time formatting ──────────────────────────────────────────────

    /** One decimal below 10 000, grouped integer above; `—` when not a number. */
    /**
     * Format a balance for a narrow row.
     *
     * Precision is unit-aware, because rounding to one decimal would print a
     * real Cline balance of `0.04 USD` as `0 USD` — the exact "spent up" reading
     * this dock avoids elsewhere. Money keeps two decimals, and any non-zero
     * value below one keeps at least two significant digits. A genuinely zero
     * balance still prints `0`.
     */
    function amount(value, unit) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      const money = unit === 'USD' || unit === '$'
      if (n !== 0 && Math.abs(n) < 1) {
        const digits = money ? 2 : 2
        return String(Number(n.toFixed(digits)))
      }
      if (money) return n.toFixed(2)
      if (Math.abs(n) >= 10_000) return String(Math.round(n).toLocaleString())
      return String(Math.round(n * 10) / 10)
    }

    /** "Updated …" caption for a reading timestamp. */
    function updatedCaption(ts, t) {
      if (!Number.isFinite(ts) || ts <= 0) return t('dock.updatedNever')
      const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
      if (seconds < 45) return t('dock.updated', { when: t('dock.updatedJustNow') })
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return t('dock.updated', { when: t('dock.minutesAgo', { n: minutes }) })
      return t('dock.updated', { when: t('dock.hoursAgo', { n: Math.round(minutes / 60) }) })
    }

    /**
     * The unit one provider's balance is denominated in.
     *
     * The pack reports a per-package `unit`: credit/credits for points,
     * `token` for ZCode's daily token pool, `USD` for Cline, `%` for Gemini's
     * quota windows. A non-credits unit is surfaced as-is rather than being
     * relabelled as credit, because "100 %" and "100 credits" mean very
     * different things.
     */
    function unitLabel(rows, t) {
      const units = new Set()
      for (const row of rows) {
        for (const entry of row?.balance?.packages ?? []) {
          const unit = typeof entry?.unit === 'string' ? entry.unit.trim() : ''
          if (unit !== '') units.add(unit.toLowerCase())
        }
      }
      if (units.size === 1) {
        const only = [...units][0]
        if (only === 'token' || only === 'tokens') return t('dock.unit.tokens')
        if (only === 'usd' || only === 'dollar' || only === 'dollars') return t('dock.unit.dollars')
        if (only === '%' || only === 'percent' || only === 'quota') return t('dock.unit.quota')
        if (only === '积分' || only === 'point' || only === 'points') return t('dock.unit.points')
        if (only === 'credit' || only === 'credits') return t('dock.unit.credit')
        return only
      }
      return t('dock.unit.credit')
    }

    /**
     * Reduce one provider's `credits.balances` accounts to a display row.
     *
     * An account whose balance came back `null` is *unknown*, not zero, so it
     * contributes no total and is counted in `failures` — showing `0` there
     * would read as "spent up", which is a different and misleading claim.
     */
    function summarize(accounts, t) {
      const rows = Array.isArray(accounts) ? accounts : []
      const known = rows.filter(row => Number.isFinite(row?.balance?.total))
      const unit = unitLabel(rows, t)
      // A quota percentage is a fraction of a window, not a quantity to add up,
      // so several accounts average instead of summing (see FRACTIONAL_UNITS).
      const additive = !FRACTIONAL_UNITS.has(unit)
      const sum = known.reduce((acc, row) => acc + Number(row.balance.total), 0)
      const total = known.length === 0
        ? null
        : additive ? sum : sum / known.length
      return {
        count: rows.length,
        failures: rows.length - known.length,
        total,
        unit,
        averaged: !additive && known.length > 1,
        /** Why the reading failed, per account — surfaced instead of a generic message. */
        errors: rows
          .map(row => (typeof row?.error === 'string' ? row.error.trim() : ''))
          .filter(error => error !== '')
          .slice(0, 2),
      }
    }

    // ── transports ──────────────────────────────────────────────────────────────

    /**
     * The shell's connection service, read per call.
     *
     * The browser half publishes `connection` after plugins load, so a value
     * captured once in `apply` can freeze as absent for the whole process.
     */
    function connectionOf(ctx) {
      try {
        const connection = ctx.get?.('connection')
        if (connection !== undefined && connection !== null) return connection
      } catch { /* service not provided yet */ }
      return undefined
    }

    /**
     * Call one endpoint on Our Free Model's channel RPC.
     *
     * This is the pack's documented wire: a `client-request` envelope on the
     * `/api` channel with endpoint `channel-pack` and a `{ method, payload }`
     * body. Going through the connection service (rather than a bare `fetch`)
     * keeps the Host's admission and origin policy in the request path.
     */
    async function channelCall(connection, method, payload, timeoutMs) {
      const rpc = connection?.rpc
      const call = rpc?.call
      if (typeof call !== 'function') throw new Error('no-connection')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const result = await call.call(rpc, '/api', CHANNEL_PACK_ENDPOINT,
          { method, payload }, controller.signal)
        if (result?.ok === true) return result.value
        if (result?.ok === false) {
          throw new Error(result.error?.message ?? result.error?.code ?? 'rpc-failed')
        }
        return result
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * Provider ids with at least one bound account, in dock order.
     *
     * `provider.status` answers
     * `{ statuses: { [provider]: { accounts: { total, enabled }, models, closed } } }`.
     */
    function connectedProviders(statuses) {
      return CHANNELS
        .filter(channel => Number(statuses?.[channel.id]?.accounts?.total ?? 0) > 0)
        .map(channel => channel.id)
    }

    /**
     * The model the current session will use next, from the list row's
     * `modelSelection` projection. `next` wins because it is the choice the
     * following request carries; `lastUsed` is the fallback for a row that has
     * made a request but recorded no newer choice.
     */
    function selectionOf(sessions, sessionId) {
      if (sessionId === undefined || sessions === undefined) return null
      const selection = sessions.byId?.[sessionId]?.projectionValues?.modelSelection
      if (selection === null || selection === undefined) return null
      const choice = selection.next ?? selection.lastUsed
      if (choice === null || choice === undefined) return null
      if (typeof choice.provider !== 'string' || typeof choice.model !== 'string') return null
      return { provider: choice.provider, model: choice.model }
    }

    /**
     * The session displayed in the main view.
     *
     * Mirrors the shell's own rule: the session the main view retains. Root
     * slots get no `sessionId`, so it is derived from the list snapshot the
     * sidebar already subscribes to.
     */
    function mainSessionId(sessions) {
      if (sessions === undefined) return undefined
      for (const id of sessions.ids ?? []) {
        if ((sessions.byId?.[id]?.retainedBy?.mainView ?? 0) > 0) return id
      }
      return undefined
    }

    /**
     * Which dock row the current selection spends credit on.
     *
     * A channel id is its own LLM provider, so the answer is the provider id
     * whenever it names a channel. A selection on `our-free-model` is the free
     * lane — no channel credit is being spent, so nothing is highlighted.
     */
    function highlightedChannel(selection) {
      if (selection === null) return undefined
      return CHANNEL_BY_ID.has(selection.provider) ? selection.provider : undefined
    }

    // ── component ───────────────────────────────────────────────────────────────

    /**
     * One provider line: identity dot, name, an "in use" badge when it backs the
     * current model, and its remaining credit.
     *
     * A provider whose balance query failed shows the reason instead of a number,
     * because `0` would read as "spent up" — a different, misleading claim.
     */
    function CreditRow(props) {
      const { row, active, t } = props
      // Prefer the provider's own reason (from `credits.balances`), falling back
      // to the transport-level error, so a failed row says *why* rather than a
      // generic "Query failed".
      const reason = row.error !== ''
        ? row.error
        : row.errors !== undefined && row.errors.length > 0 ? row.errors[0] : ''
      // The detail is a tooltip on a non-focusable row, so the reason also has to
      // be readable in the visible line for pointer-free users.
      const failed = row.total === null
      return h('li', {
        className: 'ofmcd_row',
        'data-active': active ? 'true' : 'false',
        title: active ? t('dock.inUseHint') : (reason !== '' ? t('dock.errorDetail', { reason }) : undefined),
      },
      h('span', { className: 'ofmcd_dot', style: { background: row.accent }, 'aria-hidden': 'true' }),
      h('span', { className: 'ofmcd_name' },
        h('span', { className: 'ofmcd_nameText' }, row.name),
        active ? h('span', { className: 'ofmcd_badge' }, t('dock.inUse')) : null),
      h('span', { className: 'ofmcd_value' },
        failed
          ? h('span', { className: 'ofmcd_unknown' }, t('dock.queryFailed'))
          : h('span', { className: 'ofmcd_num' }, amount(row.total, row.unit)),
        failed
          ? null
          : h('span', { className: 'ofmcd_unit' }, row.averaged
            ? `${row.unit} (${t('dock.averaged')})`
            : row.unit)))
    }

    /**
     * The dock.
     *
     * `wide` is the sidebar's own expanded/rail flag: the seat renders inside a
     * 56px rail when the sidebar is collapsed, so the rail form is a single
     * button instead of a squeezed list.
     */
    /** Pass-through selector, at module scope so its identity stays stable. */
    const identitySessions = snapshot => snapshot

    /** The session list to read when the seat supplies no `useSessions` hook. */
    const EMPTY_SESSIONS = Object.freeze({ ids: [], byId: {}, phase: 'empty', projectionsBySession: {} })

    /**
     * Stand-in for the seat's `useSessions` hook.
     *
     * A seat that supplies no hook must not turn the component's hook count into
     * a render-to-render variable — that would corrupt the whole slot's hook
     * state the first time the standard props appeared. This is a real hook (one
     * `useMemo`) returning a frozen empty snapshot, so the count is constant and
     * the dock simply shows no highlight.
     *
     * @param selector - selector over the (empty) session list snapshot.
     * @returns the selector's answer for the empty list.
     */
    function useEmptySessions(selector) {
      return useMemo(() => selector(EMPTY_SESSIONS), [selector])
    }

    function CreditDock(props) {
      const { wide, ctx } = props
      const [open, setOpen] = useState(true)
      const [state, setState] = useState({ status: 'idle', rows: [], updatedAt: 0, error: '' })
      const [absent, setAbsent] = useState(false)

      // `t` must be referentially stable: `load` depends on it and `load` is an
      // effect dependency, so a fresh wrapper per render would restart the load
      // effect on every render — a request loop. The seat's own `t` is stable
      // per namespace, so memoizing on it yields a stable wrapper.
      const frameworkT = props.t
      const translator = useMemo(() => makeT(frameworkT), [frameworkT])
      const t = useCallback((key, vars) => translator(key, vars), [translator])

      // Exactly one hook call on every render, whichever branch supplies it.
      const readSessions = typeof props.useSessions === 'function' ? props.useSessions : useEmptySessions
      const sessions = readSessions(identitySessions)
      const sessionId = useMemo(() => mainSessionId(sessions), [sessions])
      const highlighted = useMemo(
        () => highlightedChannel(selectionOf(sessions, sessionId)),
        [sessions, sessionId],
      )

      const generation = useRef(0)
      const lastManual = useRef(0)
      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      /**
       * One full read: who is connected, then each connected provider's balance.
       *
       * The calls are split because they answer different questions:
       * `provider.status` is cheap and lists accounts, while `credits.balances`
       * costs one upstream query per account. A provider whose balance query
       * fails stays listed with its reason instead of vanishing.
       */
      const load = useCallback(async () => {
        // Claim the ticket before the connection check, so an in-flight read
        // started earlier cannot land rows over the "unavailable" state this
        // call is about to publish.
        const ticket = ++generation.current
        const connection = connectionOf(ctx)
        if (connection === undefined) {
          setState({ status: 'unavailable', rows: [], updatedAt: 0, error: 'no-connection' })
          return
        }
        setState(previous => ({ ...previous, status: 'loading', error: '' }))
        try {
          const status = await channelCall(connection, 'provider.status',
            { providers: CHANNELS.map(channel => channel.id) }, 20_000)
          if (!alive.current || ticket !== generation.current) return
          const connected = connectedProviders(status?.statuses)
          setAbsent(false)
          if (connected.length === 0) {
            setState({ status: 'ready', rows: [], updatedAt: Date.now(), error: '' })
            return
          }
          const balances = await Promise.all(connected.map(async id => {
            try {
              const value = await channelCall(connection, 'credits.balances', { provider: id }, 60_000)
              return { id, accounts: value?.accounts, error: '' }
            } catch (error) {
              return { id, accounts: [], error: String(error?.message ?? error) }
            }
          }))
          if (!alive.current || ticket !== generation.current) return
          const rows = balances.map(entry => {
            const channel = CHANNEL_BY_ID.get(entry.id)
            return {
              id: entry.id,
              name: channel?.name ?? entry.id,
              accent: channel?.accent ?? 'currentColor',
              error: entry.error,
              ...summarize(entry.accounts, t),
            }
          })
          setState({ status: 'ready', rows, updatedAt: Date.now(), error: '' })
        } catch (error) {
          if (!alive.current || ticket !== generation.current) return
          const reason = String(error?.message ?? error)
          // A missing RPC means Our Free Model is absent, or its channel pack has
          // not mounted yet; say that rather than showing a transport error.
          const missing = reason === 'no-connection' || /unknown method|not found/i.test(reason)
          setAbsent(missing)
          // Keep the last good rows and their timestamp: wiping them turns a
          // transient failure into "nothing is bound", which is a false claim.
          // Only an absent provider stack clears the list, because then the rows
          // really are unknown.
          setState(previous => missing
            ? { status: 'unavailable', rows: [], updatedAt: 0, error: reason }
            : { ...previous, status: 'error', error: reason })
        }
      }, [ctx, t])

      // First read, then a slow heartbeat: the reading moves whenever a model is
      // used elsewhere, and a stale credit count is the kind of quiet wrongness
      // that reads as a bug.
      useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, BALANCE_REFRESH_MS)
        return () => clearInterval(timer)
      }, [load])

      /**
       * Re-read on a hint, at most once per floor.
       *
       * `focus` fires on every tab return and `ofm:channels` on every account
       * action, and each read fans out one upstream balance query per account.
       * Without a floor, switching tabs repeatedly stacks overlapping sweeps
       * against providers that rate-limit. The heartbeat and the explicit
       * refresh button are separate paths, so this only de-duplicates hints.
       */
      useEffect(() => {
        let lastHint = 0
        const onChanged = () => {
          const now = Date.now()
          if (now - lastHint < HINT_REFRESH_FLOOR_MS) return
          lastHint = now
          void load()
        }
        window.addEventListener('ofm:channels', onChanged)
        window.addEventListener('focus', onChanged)
        return () => {
          window.removeEventListener('ofm:channels', onChanged)
          window.removeEventListener('focus', onChanged)
        }
      }, [load])

      const refresh = useCallback(() => {
        const now = Date.now()
        if (now - lastManual.current < MANUAL_REFRESH_FLOOR_MS) return
        lastManual.current = now
        void load()
      }, [load])

      const loading = state.status === 'loading'
      const rows = state.rows
      const title = t('dock.title')
      const totalFailures = rows.reduce((sum, row) => sum + row.failures, 0)

      /** One line describing the dock when the list itself cannot be shown. */
      // `idle` is the pre-first-read status: treat it as loading, because an
      // "no channel is connected" claim before any read is simply false.
      // Shown only when there is no row to draw. With rows on screen the list
      // itself is the answer, plus a separate stale/error note below it.
      const causeText = absent ? t('dock.unavailable')
        : state.status === 'unavailable' ? t('dock.noConnection')
          : state.status === 'error' ? `${t('dock.queryFailed')}: ${state.error}`.slice(0, 180)
            : state.status === 'idle' || loading ? t('dock.loading')
              : t('dock.empty')
      /** The error note beside rows that survived a failed refresh. */
      const staleNote = rows.length > 0 && state.status === 'error'
        ? `${t('dock.queryFailed')}: ${state.error}`.slice(0, 180)
        : ''

      // Collapsed sidebar: a 36px rail seat. The tooltip carries the summary so
      // the numbers stay reachable without expanding.
      if (wide === false) {
        const inUse = rows.find(row => row.id === highlighted)
        // Rows are named per PROVIDER, and their units differ, so a single
        // summed figure would be meaningless: name the in-use provider when
        // there is one, else say how many providers are bound. Never add
        // credits to USD to percentages.
        const summary = rows.length === 0
          ? causeText
          : inUse !== undefined
            ? `${inUse.name} · ${inUse.total === null ? t('dock.unknown') : `${amount(inUse.total, inUse.unit)} ${inUse.unit}`}`
            : t('dock.providers', { n: rows.length })
        return h('button', {
          type: 'button',
          className: 'ofmcd_rail',
          title: `${title} — ${summary}`,
          'aria-label': `${title}: ${summary}`,
          onClick: refresh,
        },
        h('svg', {
          viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        },
        h('circle', { cx: 12, cy: 12, r: 8.5 }),
        h('path', { d: 'M12 7.5v9M7.5 12h9' })),
        inUse !== undefined
          ? h('span', { className: 'ofmcd_railDot', style: { background: inUse.accent }, 'aria-hidden': 'true' })
          : null,
        loading ? h('span', { className: 'ofmcd_railSpin', 'aria-hidden': 'true' }) : null)
      }

      return h('section', { className: 'ofmcd_root', 'data-open': open ? 'true' : 'false', 'aria-label': title },
        h('div', { className: 'ofmcd_head' },
          h('button', {
            type: 'button',
            className: 'ofmcd_toggle',
            'aria-expanded': open,
            title: open ? t('dock.collapse') : t('dock.expand'),
            onClick: () => setOpen(value => !value),
          },
          h('span', { className: 'ofmcd_chevron', 'data-open': open ? 'true' : 'false', 'aria-hidden': 'true' },
            h('svg', { viewBox: '0 0 12 12', width: 10, height: 10, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('path', { d: 'M4.5 2.5 8 6l-3.5 3.5' }))),
          h('span', { className: 'ofmcd_title' }, title),
          rows.length > 0
            ? h('span', { className: 'ofmcd_count' }, String(rows.length))
            : null),
          h('button', {
            type: 'button',
            className: 'ofmcd_refresh',
            title: loading ? t('dock.refreshing') : t('dock.refresh'),
            'aria-label': loading ? t('dock.refreshing') : t('dock.refresh'),
            'aria-busy': loading ? 'true' : undefined,
            disabled: loading,
            onClick: refresh,
          },
          h('svg', {
            viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor',
            strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
            className: loading ? 'ofmcd_spin' : undefined, 'aria-hidden': 'true',
          },
          h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.9-4.15' }),
          h('path', { d: 'M13.6 2.2v3.4H10.2' })))),

        open
          ? h('div', {
            className: 'ofmcd_body',
            // Refreshing changes the numbers, so announce the settled reading
            // rather than leaving a screen-reader user with a stale value.
            'aria-live': 'polite',
            'aria-busy': loading ? 'true' : undefined,
          },
            rows.length > 0
              ? h('ul', { className: 'ofmcd_list' }, rows.map(row =>
                h(CreditRow, { key: row.id, row, active: row.id === highlighted, t })))
              : h('p', { className: 'ofmcd_note' }, causeText),
            rows.length === 0 && state.status === 'ready' && !absent
              ? h('p', { className: 'ofmcd_hint' }, t('dock.emptyHint'))
              : null,
            staleNote !== ''
              ? h('p', { className: 'ofmcd_note', role: 'status' }, staleNote)
              : null,
            totalFailures > 0
              ? h('p', { className: 'ofmcd_note', role: 'status' }, t('dock.partial', { n: totalFailures }))
              : null,
            h('p', { className: 'ofmcd_foot' }, updatedCaption(state.updatedAt, t)))
          : null)
    }

    // ── styles ──────────────────────────────────────────────────────────────────
    // Theme alias tokens only: both schemes work, and a renamed token degrades
    // appearance without breaking layout.
    const CSS = `
.ofmcd_root{display:flex;flex-direction:column;min-width:0;width:100%;padding:2px 6px 0;box-sizing:border-box}
.ofmcd_head{display:flex;align-items:center;gap:2px;min-width:0;height:28px}
.ofmcd_toggle{display:flex;align-items:center;gap:5px;flex:1 1 auto;min-width:0;height:28px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;text-align:left}
.ofmcd_toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ofmcd_toggle:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-1px}
.ofmcd_chevron{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);transition:transform 140ms ease}
.ofmcd_chevron[data-open="true"]{transform:rotate(90deg)}
.ofmcd_title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.ofmcd_count{flex:none;min-width:16px;height:15px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px;text-align:center;font-variant-numeric:tabular-nums}
.ofmcd_refresh{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.ofmcd_refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ofmcd_refresh:disabled{cursor:default;opacity:.5}
.ofmcd_refresh:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-1px}
@keyframes ofmcd-spin{to{transform:rotate(360deg)}}
.ofmcd_spin{animation:ofmcd-spin 900ms linear infinite}
.ofmcd_body{display:flex;flex-direction:column;gap:3px;padding:1px 0 4px;min-width:0}
.ofmcd_list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px;min-width:0}
.ofmcd_row{display:flex;align-items:center;gap:6px;min-width:0;min-height:28px;padding:2px 6px;border-radius:var(--dsw-radius-md,8px);border:1px solid transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}
.ofmcd_row[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover-solid);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}
.ofmcd_dot{flex:none;width:6px;height:6px;border-radius:50%;opacity:.8}
.ofmcd_row[data-active="true"] .ofmcd_dot{opacity:1;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1)}
.ofmcd_name{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:4px;overflow:hidden}
.ofmcd_nameText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofmcd_badge{flex:none;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px;font-weight:400}
.ofmcd_value{flex:none;display:flex;align-items:baseline;gap:3px;font-variant-numeric:tabular-nums;max-width:52%}
.ofmcd_num{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-weight:500}
.ofmcd_unit{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px}
.ofmcd_unknown{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ofmcd_note{margin:0;padding:0 6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;overflow-wrap:anywhere}
.ofmcd_hint{margin:0;padding:0 6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;overflow-wrap:anywhere}
.ofmcd_foot{margin:0;padding:1px 6px 0;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}
.ofmcd_rail{position:relative;display:flex;align-items:center;justify-content:center;width:36px;height:36px;margin:0 auto;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ofmcd_rail:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ofmcd_rail:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-1px}
.ofmcd_railDot{position:absolute;top:6px;right:6px;width:5px;height:5px;border-radius:50%;box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base)}
.ofmcd_railSpin{position:absolute;inset:0;border-radius:8px;border:1.5px solid transparent;border-top-color:var(--dsw-alias-brand-primary);animation:ofmcd-spin 900ms linear infinite}
@media (prefers-reduced-motion: reduce){
  .ofmcd_chevron{transition:none}
  .ofmcd_spin,.ofmcd_railSpin{animation:none}
}
`

    /** Install the stylesheet once, returning its removal. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@zhang-astronaut/ofm-credit-dock'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /**
     * Translator built over the seat's framework `t`.
     *
     * The framework `t` is bound to this plugin's namespace and re-renders on a
     * language switch, but it returns the key itself when the namespace is not
     * registered yet (this plugin's row and the shell's locale row activate in
     * any order). Treating "returned the key unchanged" as a miss and falling
     * back to the bundled English table makes the dock readable in that window
     * instead of printing raw keys.
     *
     * @param frameworkT - the seat's `t`, or undefined when the locale seat is absent.
     * @returns the translate function used by the dock.
     */
    /**
     * Bind a stable translator over the seat's framework `t`.
     *
     * The framework `t` is bound to this plugin's namespace and re-renders on a
     * language switch, but it returns the key itself when the namespace is not
     * registered yet (this plugin's row and the shell's locale row activate in
     * any order). Treating "returned the key unchanged" as a miss and falling
     * back to the bundled English table makes the dock readable in that window
     * instead of printing raw keys.
     *
     * @param frameworkT - the seat's `t`, or undefined when the locale seat is absent.
     * @returns the translate function used by the dock.
     */
    function makeT(frameworkT) {
      return (key, vars) => {
        let text
        if (typeof frameworkT === 'function') {
          try { text = frameworkT(key) } catch { text = undefined }
        }
        if (typeof text !== 'string' || text === '' || text === key) text = en[key] ?? key
        return format(text, vars)
      }
    }

    return {
      // `slots` is the only hard requirement; `locale` is optional and folded
      // into the deferred registration below so the dock still mounts when a
      // composition has no locale face (it then renders the bundled English table).
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'ofm-credit-dock: styles')

        /** Whether the locale dictionaries are registered (the slot's `locale` option). */
        let translated = false
        /** The current seat registration's disposer, if any. */
        let disposeSeat

        /**
         * Register the seat, declaring the locale namespace only when the
         * dictionaries exist.
         *
         * The `locale` option makes the renderer hand the component a framework
         * `t` seat; declaring it before the namespace is registered would hand
         * out a translator that only echoes keys. So the seat is (re)registered
         * when that changes — at most once, because the dictionaries never go
         * away.
         */
        const installSeat = hasLocale => {
          if (disposeSeat !== undefined) disposeSeat()
          translated = hasLocale
          disposeSeat = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'ofm-credit-dock',
            // Above the host's own footer rows and the always-present Settings
            // row, so the dock is the first thing in the lower-left stack.
            order: -10,
            ...hasLocale ? { locale: NS } : {},
          }, props => h(CreditDock, {
            ...props,
            ctx,
            // Pass the seat's `t` through untouched: the component memoizes its
            // own wrapper on this reference, and a wrapper created here would be
            // new on every render and defeat that memo.
            t: props.t,
          })))
        }

        const useLocale = () => {
          if (translated) return
          let locale
          try { locale = ctx.get?.('locale') } catch { return }
          if (locale === undefined || locale === null || typeof locale.register !== 'function') return
          ctx.effect(() => locale.register(NS, DICTS), 'ofm-credit-dock: dictionaries')
          installSeat(true)
        }

        // A locale face is normally already installed (the web-app bundle mounts
        // it), so try it first and register once, translated. Registering
        // untranslated first would mount every user through a throwaway seat.
        try { useLocale() } catch { /* fall through to the deferred path */ }

        if (!translated) {
          // Mount now, untranslated: `makeT` falls back to the bundled English
          // table, so the dock is readable rather than absent while it waits.
          installSeat(false)
          // `ctx.inject` keeps this callback installed until `locale` exists, so
          // a late-arriving service still upgrades the seat. A shell without it
          // just probes once instead.
          try {
            if (typeof ctx.inject === 'function') ctx.inject(['locale'], useLocale)
            else useLocale()
          } catch { useLocale() }
        }

        ctx.effect(() => () => {
          if (disposeSeat !== undefined) {
            disposeSeat()
            disposeSeat = undefined
          }
        }, 'ofm-credit-dock: seat')
      },
    }
  },
})
