import type { Address } from 'viem'
import './ui/style.css'
import { COW_EXPLORER, fetchOrder, fetchOrders, fetchQuote, fetchTradeHashes, type OrderStatus, submitOrder } from './core/cow'
import { formatFiat, formatPercent, formatPrice, formatUnitsFixed, parseAmount, shortAddress } from './core/format'
import { checkMove, deviationBps, LIMITS, refusalText, toNumber } from './core/guard'
import { type MoveDeps, type MoveResult, type MoveStep, previewQuote, runMove } from './core/move'
import { minimumReceived, type Quote } from './core/order'
import { fetchPrices, PRICE_SOURCE, type PriceTable, statementFiat } from './core/prices'
import { fetchValidators, MIN_STAKE_LUNA, type Staker, type Validator } from './core/staking'
import { type Balances, buildStatement, NIM_DECIMALS, type StatementRow } from './core/statement'
import { ALL_TOKENS, type HoldingId, type Token, tokenById, USDT } from './core/tokens'
import { allowance, balanceOf, connectEvm, ensurePolygon, type Eip1193, evmProvider, nonce, POLYGONSCAN_TX, signTypedData, tokenBalances } from './wallet/evm'
import { connectNimiq, hostFiat, insideNimiqPay, nimBalance, type NimiqSession, nimStaker, stake } from './wallet/nimiq'
import { mark, MARK_COLOR, type MarkId } from './ui/marks'

type View = 'statement' | 'holding' | 'nim' | 'activity'
type Direction = 'in' | 'out'
type StepState = 'todo' | 'now' | 'done'

const PREVIEW_OWNER: Address = '0x000000000000000000000000000000000000dEaD'
const APP_URL = 'marc-dvci.github.io/Coffer/'
const OPEN_IN_PAY = `https://nimpay.app/miniapps/open/${APP_URL}`

const state = {
  view: 'statement' as View,
  holding: 'gold' as HoldingId,
  direction: 'in' as Direction,
  evm: null as { provider: Eip1193; owner: Address } | null,
  nimiq: null as NimiqSession | null,
  balances: { tokens: {}, nimLuna: 0n, stakedLuna: 0n } as Balances,
  staker: null as Staker | null,
  prices: null as PriceTable | null,
  validators: [] as Validator[],
  validator: '',
  orders: null as OrderStatus[] | null,
  quote: null as Quote | null,
  quoteNote: '',
  busy: false,
  steps: [] as { label: string; state: StepState }[],
  result: null as MoveResult | null,
  stakeNote: '',
  stakeHash: '',
  connectNote: '',
  connecting: false,
}

const app = document.getElementById('app')!
const fiat = () => statementFiat(hostFiat())
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const priceUsd = (t: Token) => state.prices?.[t.id].USD

function pair(): { sell: Token; buy: Token } {
  const saved = tokenById(state.holding)
  return state.direction === 'in' ? { sell: USDT, buy: saved } : { sell: saved, buy: USDT }
}

/* ---------- data ---------- */

async function refreshBalances(): Promise<void> {
  const jobs: Promise<void>[] = []
  if (state.evm) {
    jobs.push(
      tokenBalances(state.evm.owner).then((t) => {
        state.balances.tokens = t
      }),
    )
  }
  if (state.nimiq) {
    const session = state.nimiq
    jobs.push(
      nimBalance(session).then((v) => {
        state.balances.nimLuna = v
      }),
      nimStaker(session).then((s) => {
        state.staker = s
        state.balances.stakedLuna = s ? s.balanceLuna : 0n
      }),
    )
  }
  await Promise.allSettled(jobs)
}

async function refreshPrices(): Promise<void> {
  try {
    state.prices = await fetchPrices()
  } catch {
    /* the statement shows amounts without values until prices answer */
  }
}

function isDeclined(err: unknown): boolean {
  const e = err as { code?: number; message?: string }
  return e?.code === 4001 || /reject|denied|cancel/i.test(e?.message ?? '')
}

function walletMessage(err: unknown): string {
  return isDeclined(err)
    ? 'The connection was declined in the wallet.'
    : ((err as { message?: string })?.message ?? 'The wallet did not answer.')
}

async function connect(): Promise<void> {
  if (state.connecting) return
  state.connecting = true
  state.connectNote = ''
  render()
  const provider = evmProvider()
  try {
    if (provider && !state.evm) state.evm = { provider, owner: await connectEvm(provider) }
  } catch (err) {
    state.connectNote = walletMessage(err)
  }
  try {
    if (!state.nimiq) state.nimiq = await connectNimiq()
  } catch (err) {
    state.connectNote = walletMessage(err)
  }
  state.connecting = false
  await refreshBalances()
  render()
}

function moveDeps(): MoveDeps {
  const evm = state.evm!
  return {
    now: () => Math.floor(Date.now() / 1000),
    balanceOf,
    allowance,
    nonce,
    signTypedData: (owner, data) => signTypedData(evm.provider, owner, data),
    quote: (req) => fetchQuote(req),
    submit: (sub) => submitOrder(sub),
    order: (uid) => fetchOrder(uid),
    tradeHashes: (uid) => fetchTradeHashes(uid),
    priceUsd,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

/* ---------- quote ---------- */

let quoteSeq = 0
let quoteTimer: ReturnType<typeof setTimeout> | undefined

function amountInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('#amount')
}

function typedAmount(): bigint | null {
  const input = amountInput()
  return input ? parseAmount(input.value, pair().sell.decimals) : null
}

function scheduleQuote(): void {
  clearTimeout(quoteTimer)
  state.quote = null
  state.quoteNote = ''
  const amount = typedAmount()
  if (amount === null || amount === 0n) {
    renderQuote()
    return
  }
  state.quoteNote = 'Asking for a price…'
  renderQuote()
  const seq = ++quoteSeq
  quoteTimer = setTimeout(async () => {
    const { sell, buy } = pair()
    try {
      const quote = await previewQuote(
        { quote: (req) => fetchQuote(req) } as MoveDeps,
        { owner: state.evm?.owner ?? PREVIEW_OWNER, sell, buy, amount },
      )
      if (seq !== quoteSeq) return
      state.quote = quote
      state.quoteNote = ''
    } catch (err) {
      if (seq !== quoteSeq) return
      state.quoteNote = (err as Error).message
    }
    renderQuote()
  }, 450)
}

function quoteRefusal(): string {
  const { sell, buy } = pair()
  if (!state.quote) return ''
  const balance = state.evm ? (state.balances.tokens[sell.id] ?? 0n) : state.quote.sellAmount + state.quote.feeAmount
  const refusal = checkMove({
    quote: state.quote,
    balance,
    sellDecimals: sell.decimals,
    buyDecimals: buy.decimals,
    sellPriceUsd: priceUsd(sell),
    buyPriceUsd: priceUsd(buy),
  })
  return refusal ? refusalText(refusal) : ''
}

function renderQuote(): void {
  const el = document.getElementById('quote')
  if (!el) return
  const { sell, buy } = pair()
  const q = state.quote
  if (!q) {
    el.innerHTML = state.quoteNote ? `<p class="note">${esc(state.quoteNote)}</p>` : ''
    return
  }
  const refusal = quoteRefusal()
  const dev = deviationBps({
    quote: q,
    balance: 0n,
    sellDecimals: sell.decimals,
    buyDecimals: buy.decimals,
    sellPriceUsd: priceUsd(sell),
    buyPriceUsd: priceUsd(buy),
  })
  const min = minimumReceived(q.buyAmount, LIMITS.slippageBps)
  const canSign = state.evm !== null && !refusal && !state.busy
  el.innerHTML = `
    <dl class="facts">
      <div><dt>You receive about</dt><dd><b>${formatUnitsFixed(q.buyAmount, buy.decimals, buy.display)} ${buy.symbol}</b></dd></div>
      <div><dt>At least</dt><dd>${formatUnitsFixed(min, buy.decimals, buy.display)} ${buy.symbol}</dd></div>
      <div><dt>Network fee, paid in ${sell.symbol}</dt><dd>${formatUnitsFixed(q.feeAmount, sell.decimals, Math.min(sell.decimals, 6))} ${sell.symbol}</dd></div>
      <div><dt>Against the ${PRICE_SOURCE} price</dt><dd>${priceUsd(buy) === undefined ? 'n/a' : `${dev > 0 ? '-' : '+'}${(Math.abs(dev) / 100).toFixed(2)}%`}</dd></div>
    </dl>
    ${refusal ? `<p class="refusal" role="alert">${esc(refusal)}</p>` : ''}
    ${
      state.evm
        ? `<button class="primary" id="sign" ${canSign ? '' : 'disabled'}>Sign and move</button>
           <p class="note">Nimiq Pay shows up to two “Sign Message” sheets. The first, type ${sell.approval === 'permit' ? 'Permit' : 'MetaTransaction'}, lets CoW Protocol take exactly this amount of ${sell.symbol} and nothing more. The second, type Order, is the move itself, with you as the receiver. A solver settles it and pays the gas, so no POL is needed. The ${buy.symbol} arrives at your own address, ${shortAddress(state.evm.owner)}.</p>`
        : `<a class="secondary" href="${OPEN_IN_PAY}">Open in Nimiq Pay to move savings</a>
           <p class="note">This is a live price. Signing happens in Nimiq Pay, with the wallet that holds your USDT.</p>`
    }`
}

/* ---------- move ---------- */

function setSteps(labels: string[], current: number): void {
  state.steps = labels.map((label, i) => ({
    label,
    state: i < current ? 'done' : i === current ? 'now' : 'todo',
  }))
  renderProgress()
}

async function startMove(): Promise<void> {
  const amount = typedAmount()
  if (!state.evm || amount === null || amount === 0n || state.busy) return
  const { sell, buy } = pair()
  state.busy = true
  state.result = null
  const labels = [
    `Sign the ${sell.symbol} approval for exactly this amount`,
    'Check the final price against the limits',
    'Sign the order',
    'A solver settles the order on Polygon',
    'Read the result back from the chain',
  ]
  setSteps(labels, 0)
  render()
  const onStep = (s: MoveStep): void => {
    const index = { 'approval-signature': 0, quote: 1, 'order-signature': 2, placed: 3, settling: 3 }[s.step]
    setSteps(labels, index)
  }
  try {
    await ensurePolygon(state.evm.provider)
    state.result = await runMove(moveDeps(), { owner: state.evm.owner, sell, buy, amount }, onStep)
  } catch (err) {
    state.result = isDeclined(err)
      ? { outcome: 'declined', at: 'approval-signature' }
      : { outcome: 'rejected', reason: (err as Error).message }
  }
  if (state.result.outcome === 'settled') setSteps(labels, labels.length)
  state.busy = false
  state.orders = null
  await refreshBalances()
  render()
}

function renderProgress(): void {
  const el = document.getElementById('progress')
  if (!el) return
  el.innerHTML = `<ol class="steps">${state.steps
    .map(
      (s) =>
        `<li data-state="${s.state}"><i>${s.state === 'done' ? '✓' : s.state === 'now' ? '●' : '○'}</i><span>${esc(s.label)}</span></li>`,
    )
    .join('')}</ol>`
}

function resultHtml(r: MoveResult): string {
  const { sell, buy } = pair()
  switch (r.outcome) {
    case 'settled':
      return `
        <p class="stamp">Moved.</p>
        <dl class="facts">
          <div><dt>Sold</dt><dd>${formatUnitsFixed(r.sold, sell.decimals, sell.display)} ${sell.symbol}</dd></div>
          <div><dt>Received</dt><dd><b>${formatUnitsFixed(r.received, buy.decimals, buy.display)} ${buy.symbol}</b></dd></div>
          <div><dt>Network fee</dt><dd>${formatUnitsFixed(r.fee, sell.decimals, Math.min(sell.decimals, 6))} ${sell.symbol}</dd></div>
          <div><dt>${buy.symbol} at your address now</dt><dd>${formatUnitsFixed(r.balanceAfter, buy.decimals, buy.display)}</dd></div>
          <div><dt>Receipt</dt><dd>${r.txHash ? `<a href="${POLYGONSCAN_TX}${r.txHash}" target="_blank" rel="noopener">Polygon transaction</a> · ` : ''}<a href="${COW_EXPLORER}${r.uid}" target="_blank" rel="noopener">order</a></dd></div>
        </dl>`
    case 'expired':
      return `<p class="refusal" role="alert">No solver filled the order before it expired. Nothing moved. <a href="${COW_EXPLORER}${r.uid}" target="_blank" rel="noopener">See the order</a>.</p>`
    case 'declined':
      return `<p class="note">Signature declined in the wallet. Nothing moved.</p>`
    case 'refused':
      return `<p class="refusal" role="alert">${esc(refusalText(r.refusal))} Nothing moved.</p>`
    case 'rejected':
      return `<p class="refusal" role="alert">${esc(r.reason)} Nothing moved.</p>`
  }
}

/* ---------- views ---------- */

function rowSub(row: StatementRow): string {
  if (row.id === 'nim' || row.id === 'staked') return `${row.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} NIM`
  const t = tokenById(row.id)
  return `${row.amount.toLocaleString('en-US', { maximumFractionDigits: t.display })} ${t.symbol}`
}

function connectBanner(): string {
  const inPay = insideNimiqPay()
  if (state.evm !== null && (state.nimiq !== null || !inPay)) return ''
  if (inPay) {
    return state.connecting
      ? `<p class="banner">Nimiq Pay is asking to share your addresses with Coffer. Coffer reads balances with them and moves nothing without your signature.</p>`
      : `<p class="banner">Coffer shows your holdings once you share your addresses.</p><button class="primary" id="connect">Connect wallet</button>`
  }
  return `<p class="banner">Prices and quotes on this page are live. To see your own holdings and move savings, <a href="${OPEN_IN_PAY}">open Coffer in Nimiq Pay</a>${evmProvider() && !state.evm ? ' or <a href="#" id="connect">connect this browser’s wallet</a>' : ''}.</p>`
}

function statementView(): string {
  const f = fiat()
  const st = buildStatement(state.balances, state.prices ?? { usdt: {}, gold: {}, euro: {}, bitcoin: {}, nim: {} }, f)
  const bar = st.total > 0
    ? `<div class="bar" role="img" aria-label="Share of each holding in the total">${st.rows
        .filter((r) => (r.value ?? 0) > 0)
        .map((r) => `<i style="width:${(((r.value ?? 0) / st.total) * 100).toFixed(2)}%;background:${MARK_COLOR[r.id as Exclude<MarkId, 'coffer'>]}"></i>`)
        .join('')}</div>`
    : ''
  return `
    ${connectBanner()}
    ${state.connectNote ? `<p class="refusal" role="alert">${esc(state.connectNote)}</p>` : ''}
    <section class="total">
      <small>You hold</small>
      <h1>${formatFiat(st.total, f)}</h1>
      <p>${st.total > 0 ? `<b>${formatPercent(st.savedShare)}</b> is in gold, euros or bitcoin.` : 'Gold, euros and bitcoin, at your own address.'}</p>
      ${bar}
    </section>
    <ul class="rows">
      ${st.rows
        .map(
          (r) => `<li><button class="row" data-row="${r.id}">
            ${mark(r.id as MarkId)}
            <span><span class="name">${esc(r.label)}</span><span class="sub">${rowSub(r)}</span></span>
            <span class="val">${formatFiat(r.value, f)}${priceLine(r, f)}</span>
          </button></li>`,
        )
        .join('')}
    </ul>
    <p class="note">Values use ${PRICE_SOURCE} prices in ${f}. Balances are read from Polygon and from the Nimiq network.</p>`
}

function priceLine(r: StatementRow, f: ReturnType<typeof fiat>): string {
  const id = r.id === 'staked' ? 'nim' : r.id
  const p = state.prices?.[id][f]
  if (p === undefined || id === 'usdt') return ''
  return `<span class="sub">${formatPrice(p, f)} each</span>`
}

function holdingView(): string {
  const t = tokenById(state.holding)
  const f = fiat()
  const held = state.balances.tokens[t.id] ?? 0n
  const price = state.prices?.[t.id][f]
  const { sell } = pair()
  const sellBal = state.balances.tokens[sell.id] ?? 0n
  const chips = state.direction === 'in' ? ['1', '10', '50'] : []
  return `
    <button class="back" data-nav="statement">‹ Statement</button>
    <div class="head">${mark(t.id)}<h2>${t.label}</h2></div>
    <dl class="facts">
      <div><dt>You hold</dt><dd><b>${formatUnitsFixed(held, t.decimals, t.display)} ${t.symbol}</b></dd></div>
      <div><dt>Worth</dt><dd>${formatFiat(price === undefined ? undefined : toNumber(held, t.decimals) * price, f)}</dd></div>
      <div><dt>Price, ${PRICE_SOURCE}</dt><dd>${formatFiat(price, f)} per ${t.symbol}</dd></div>
      <div><dt>Issuer</dt><dd>${t.issuer}</dd></div>
    </dl>
    <p class="note">${t.unit} The price moves both ways.</p>
    ${
      state.result || state.busy
        ? `<div id="progress"></div>${state.result ? resultHtml(state.result) : ''}
           ${state.busy ? '<p class="note">Keep this screen open. An order stays open for 20 minutes; unfilled, it expires and nothing moves.</p>' : '<button class="secondary" id="again">Make another move</button>'}`
        : `<div class="tabs" role="tablist">
            <button role="tab" aria-selected="${state.direction === 'in'}" data-dir="in">Move in</button>
            <button role="tab" aria-selected="${state.direction === 'out'}" data-dir="out">Bring back</button>
          </div>
          <label class="amount" for="amount">${state.direction === 'in' ? `USDT to turn into ${t.label.toLowerCase()}` : `${t.symbol} to turn back into USDT`}</label>
          <div class="field"><input id="amount" inputmode="decimal" autocomplete="off" placeholder="0" aria-describedby="avail" /><span>${sell.symbol}</span></div>
          <div class="chips">
            ${chips.map((c) => `<button data-chip="${c}">$${c}</button>`).join('')}
            ${state.evm ? `<button data-chip="max">All</button>` : ''}
          </div>
          <p class="note" id="avail">${state.evm ? `Available: ${formatUnitsFixed(sellBal, sell.decimals, sell.display)} ${sell.symbol}.${sellBal > 0n ? '' : state.direction === 'in' ? ' Top up USDT in Nimiq Pay, then move it here. Any amount typed above shows a live price.' : ` Move USDT into ${t.label.toLowerCase()} first.`}` : `Smallest move: $${LIMITS.minUsd}.`}</p>
          <div id="quote"></div>`
    }`
}

function nimView(): string {
  const f = fiat()
  const p = state.prices?.nim[f]
  const nim = state.balances.nimLuna
  const staked = state.balances.stakedLuna
  const current = state.validators.find((v) => v.address === state.staker?.validator)
  return `
    <button class="back" data-nav="statement">‹ Statement</button>
    <div class="head">${mark('staked')}<h2>NIM that earns</h2></div>
    <dl class="facts">
      <div><dt>Spendable NIM</dt><dd>${formatUnitsFixed(nim, NIM_DECIMALS, 2)} NIM</dd></div>
      <div><dt>Staked NIM</dt><dd><b>${formatUnitsFixed(staked, NIM_DECIMALS, 2)} NIM</b></dd></div>
      <div><dt>Staked value</dt><dd>${formatFiat(p === undefined ? undefined : toNumber(staked, NIM_DECIMALS) * p, f)}</dd></div>
      ${state.staker?.validator ? `<div><dt>Staked with</dt><dd>${esc(current?.name ?? state.staker.validator)}</dd></div>` : ''}
    </dl>
    <p class="note">Staked NIM stays yours and earns network rewards through a pool. Rewards vary. The smallest first stake is 100 NIM.</p>
    ${
      state.staker
        ? ''
        : `<h2 style="font-size:20px;margin-top:18px">Choose a pool</h2>
      <ul class="validators">${state.validators
        .slice(0, 6)
        .map(
          (v) => `<li><label><input type="radio" name="validator" value="${esc(v.address)}" ${v.address === state.validator ? 'checked' : ''}/>
            <span>${esc(v.name)}<br><span class="sub">trust ${(v.score * 100).toFixed(1)}% · pays ${v.payout === 'restake' ? 'into your stake' : 'to your wallet'}</span></span>
            <span>${(v.fee * 100).toFixed(1)}% fee</span></label></li>`,
        )
        .join('')}</ul>
      <p class="note">Pools are ranked by the Nimiq validator trust score, then by fee.</p>`
    }
    <label class="amount" for="stake-amount">NIM to stake</label>
    <div class="field"><input id="stake-amount" inputmode="decimal" autocomplete="off" placeholder="0" /><span>NIM</span></div>
    ${state.stakeNote ? `<p class="refusal" role="alert">${esc(state.stakeNote)}</p>` : ''}
    ${state.stakeHash ? `<p class="stamp">Staked.</p><p class="note">Transaction ${esc(shortAddress(state.stakeHash))} sent. The staked balance updates within a minute.</p>` : ''}
    ${
      state.nimiq
        ? `<button class="primary" id="stake">Stake</button>`
        : `<a class="secondary" href="${OPEN_IN_PAY}">Open in Nimiq Pay to stake</a>`
    }`
}

function activityView(): string {
  const rows = (state.orders ?? []).filter((o) => o.appCode === 'Coffer')
  const sym = (a: string) => ALL_TOKENS.find((t) => t.address.toLowerCase() === a.toLowerCase())
  const line = (o: OrderStatus): string => {
    const s = sym(o.sellToken)
    const b = sym(o.buyToken)
    if (!s || !b) return ''
    const what =
      o.state === 'fulfilled'
        ? `${formatUnitsFixed(o.executedSellAmount, s.decimals, s.display)} ${s.symbol} → ${formatUnitsFixed(o.executedBuyAmount, b.decimals, b.display)} ${b.symbol}`
        : `${s.symbol} → ${b.symbol}`
    return `<div><dt>${new Date(o.createdAt).toLocaleDateString()} · ${o.state === 'fulfilled' ? 'moved' : o.state}</dt><dd><a href="${COW_EXPLORER}${o.uid}" target="_blank" rel="noopener">${what}</a></dd></div>`
  }
  return `
    <div class="head">${mark('coffer')}<h2>Activity</h2></div>
    ${
      !state.evm
        ? `<p class="note">Your moves appear here once Coffer is open in Nimiq Pay.</p>`
        : state.orders === null
          ? `<p class="note">Reading your orders…</p>`
          : rows.length === 0
            ? `<p class="note">No moves yet. Pick a holding on the statement to make the first one.</p>`
            : `<dl class="facts">${rows.map(line).join('')}</dl>`
    }
    <p class="note">This list is read from the public CoW Protocol order book for your address. Coffer keeps no record of its own.</p>`
}

function render(): void {
  const who = state.evm ? shortAddress(state.evm.owner) : state.connecting ? 'Connecting…' : insideNimiqPay() ? 'Not connected' : 'Live prices'
  const body =
    state.view === 'holding' ? holdingView() : state.view === 'nim' ? nimView() : state.view === 'activity' ? activityView() : statementView()
  app.innerHTML = `
    <header class="top">
      <button class="brand" data-nav="statement" aria-label="Coffer, statement">${mark('coffer')}<span>Coffer</span></button>
      <span class="who">${who}</span>
    </header>
    <main>${body}</main>
    <nav class="bottom" aria-label="Sections">
      <button data-nav="statement" ${state.view !== 'activity' ? 'aria-current="page"' : ''}>Statement</button>
      <button data-nav="activity" ${state.view === 'activity' ? 'aria-current="page"' : ''}>Activity</button>
    </nav>`
  if (state.view === 'holding') {
    renderProgress()
    renderQuote()
  }
}

/* ---------- events ---------- */

async function openActivity(): Promise<void> {
  if (!state.evm || state.orders !== null) return
  try {
    state.orders = await fetchOrders(state.evm.owner)
  } catch {
    state.orders = []
  }
  render()
}

async function doStake(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#stake-amount')
  const luna = input ? parseAmount(input.value, NIM_DECIMALS) : null
  state.stakeNote = ''
  state.stakeHash = ''
  if (!state.nimiq || luna === null || luna === 0n) state.stakeNote = 'Enter an amount of NIM.'
  else if (!state.staker && luna < MIN_STAKE_LUNA) state.stakeNote = 'The smallest first stake is 100 NIM.'
  else if (luna > state.balances.nimLuna) state.stakeNote = 'This is more NIM than the wallet holds.'
  else if (!state.staker && !state.validator) state.stakeNote = 'Choose a pool first.'
  else {
    try {
      state.stakeHash = await stake(state.nimiq, state.validator, luna, state.staker)
      setTimeout(() => void refreshBalances().then(render), 8000)
    } catch (err) {
      state.stakeNote = `${(err as Error).message} Nothing was staked.`
    }
  }
  render()
}

app.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('button, a')
  if (!el) return
  const nav = el.dataset.nav as View | undefined
  if (nav) {
    state.view = nav
    state.result = null
    state.quote = null
    render()
    if (nav === 'activity') void openActivity()
    return
  }
  const row = el.dataset.row
  if (row) {
    if (row === 'nim' || row === 'staked') state.view = 'nim'
    else {
      state.view = 'holding'
      state.holding = row === 'usdt' ? 'gold' : (row as HoldingId)
      state.direction = 'in'
    }
    state.result = null
    state.quote = null
    render()
    window.scrollTo(0, 0)
    return
  }
  const dir = el.dataset.dir as Direction | undefined
  if (dir) {
    state.direction = dir
    state.quote = null
    render()
    return
  }
  const chip = el.dataset.chip
  if (chip) {
    const input = amountInput()
    const { sell } = pair()
    if (input) {
      input.value =
        chip === 'max'
          ? formatUnitsFixed(state.balances.tokens[sell.id] ?? 0n, sell.decimals, sell.decimals).replace(/,/g, '')
          : chip
      scheduleQuote()
    }
    return
  }
  if (el.id === 'sign') void startMove()
  if (el.id === 'again') {
    state.result = null
    state.quote = null
    render()
  }
  if (el.id === 'stake') void doStake()
  if (el.id === 'connect') {
    ev.preventDefault()
    void connect()
  }
})

app.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement
  if (el.id === 'amount') scheduleQuote()
  if (el.name === 'validator') state.validator = el.value
})

/* ---------- start ---------- */

async function start(): Promise<void> {
  render()
  void refreshPrices().then(render)
  void fetchValidators()
    .then((v) => {
      state.validators = v
      state.validator = v[0]?.address ?? ''
      if (state.view === 'nim') render()
    })
    .catch(() => {})
  for (let i = 0; i < 15 && !insideNimiqPay(); i++) await new Promise((r) => setTimeout(r, 100))
  if (insideNimiqPay()) await connect()
  setInterval(() => void refreshPrices().then(() => state.view === 'statement' && render()), 60_000)
}

void start()
