import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { decodeFunctionData } from 'viem'
import { APPROVAL_ABI } from '../../src/core/approval'
import { shortAddress } from '../../src/core/format'
import { GOLD, USDT } from '../../src/core/tokens'
import { account, COW_VAULT_RELAYER, installWorld } from './world'

async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([])
}

async function openGold(page: Page, amount: string): Promise<void> {
  await page.getByRole('button', { name: /Gold/ }).click()
  await page.getByLabel('USDT to turn into gold').fill(amount)
  await expect(page.getByText('You receive about')).toBeVisible()
}

test.describe('in a plain browser', () => {
  test('the statement shows live prices and sends the visitor to Nimiq Pay', async ({ page }) => {
    await installWorld(page, { insidePay: false })
    await page.goto('./')
    await expect(page.getByText('$4,000.00 each')).toBeVisible()
    await expect(page.getByRole('link', { name: 'open Coffer in Nimiq Pay' })).toHaveAttribute(
      'href',
      /nimpay\.app\/miniapps\/open\//,
    )
    await expectAccessible(page)
  })

  test('a quote appears without a wallet and nothing can be signed', async ({ page }) => {
    await installWorld(page, { insidePay: false })
    await page.goto('./')
    await openGold(page, '25')
    await expect(page.getByText(/0\.0062\d PAXG/).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign and move' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Open in Nimiq Pay to move savings' })).toBeVisible()
    await expectAccessible(page)
  })
})

test.describe('inside Nimiq Pay', () => {
  test('the statement values every holding in the phone’s currency', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true, userFiat: 'EUR' })
    world.balances.gold = 5n * 10n ** 16n
    await page.goto('./')
    await expect(page.getByRole('button', { name: /Dollars/ })).toContainText('€108.00')
    await expect(page.getByRole('button', { name: /Gold/ })).toContainText('€180.00')
    await expect(page.locator('[data-row="nim"]')).toContainText('2,500 NIM')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('€288.56')
    await expect(page.getByText('62% is in gold, euros or bitcoin.')).toBeVisible()
    await expectAccessible(page)
  })

  test('opening the app asks only to share the addresses, with no network switch', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    await page.goto('./')
    await expect(page.getByText(shortAddress(account.address))).toBeVisible()
    expect(world.prompts).toEqual(['eth_requestAccounts'])
  })

  test('a move switches the wallet to Polygon before the first signature', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    await page.goto('./')
    await openGold(page, '25')
    await page.getByRole('button', { name: 'Sign and move' }).click()
    await expect(page.getByText('Moved.')).toBeVisible({ timeout: 20_000 })
    expect(world.prompts).toEqual(['eth_requestAccounts', 'wallet_switchEthereumChain'])
    expect(world.signed).toEqual(['Permit', 'Order'])
  })

  test('a declined connection leaves a Connect wallet button that connects on the next try', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    world.rejectConnect = true
    await page.goto('./')
    await expect(page.getByText('The connection was declined in the wallet.')).toBeVisible()
    await expect(page.getByText('Not connected')).toBeVisible()
    await expectAccessible(page)
    await page.getByRole('button', { name: 'Connect wallet' }).click()
    await expect(page.getByText(shortAddress(account.address))).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect wallet' })).toHaveCount(0)
  })

  test('a wallet with no USDT is told to top up and still sees a live price', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    world.balances.usdt = 0n
    await page.goto('./')
    await openGold(page, '5')
    await expect(page.getByText('Top up USDT in Nimiq Pay, then move it here.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign and move' })).toBeDisabled()
    await expectAccessible(page)
  })

  test('moving USDT into gold takes two signatures and ends on a receipt read from the chain', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    await page.goto('./')
    await openGold(page, '25')
    await page.getByRole('button', { name: 'Sign and move' }).click()
    await expect(page.getByText('Moved.')).toBeVisible({ timeout: 20_000 })

    expect(world.signed).toEqual(['Permit', 'Order'])
    expect(world.submitted).toHaveLength(1)
    const { body, signer } = world.submitted[0]!
    expect(signer).toBe(account.address)
    expect(body.receiver).toBe(account.address)
    expect(body.sellAmount).toBe('25000000')
    expect(body.feeAmount).toBe('0')

    const hooks = (JSON.parse(body.appData as string) as { metadata: { hooks: { pre: { target: string; callData: `0x${string}` }[] } } }).metadata.hooks.pre
    expect(hooks).toHaveLength(1)
    expect(hooks[0]!.target).toBe(USDT.address)
    const permit = decodeFunctionData({ abi: APPROVAL_ABI, data: hooks[0]!.callData })
    expect(permit.functionName).toBe('permit')
    expect(permit.args?.slice(0, 3)).toEqual([account.address, COW_VAULT_RELAYER, 25_000_000n])

    await expect(page.getByText('PAXG at your address now')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Polygon transaction' })).toHaveAttribute('href', /polygonscan\.com\/tx\/0xcd/)
    await expectAccessible(page)

    await page.getByRole('button', { name: 'Coffer, statement' }).click()
    await expect(page.getByRole('button', { name: /Gold/ })).toContainText(/0\.0062\d PAXG/)
    await expect(page.getByRole('button', { name: /Dollars/ })).toContainText('95 USDT')
  })

  test('with an allowance already in place the move takes one signature', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    world.allowances.usdt = 10n ** 12n
    await page.goto('./')
    await openGold(page, '10')
    await page.getByRole('button', { name: 'Sign and move' }).click()
    await expect(page.getByText('Moved.')).toBeVisible({ timeout: 20_000 })
    expect(world.signed).toEqual(['Order'])
    expect(JSON.parse(world.submitted[0]!.body.appData as string).metadata).toEqual({})
  })

  test('bringing gold back to USDT signs a meta-transaction approval for the exact amount', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    world.balances.gold = 2n * 10n ** 16n
    await page.goto('./')
    await page.getByRole('button', { name: /Gold/ }).click()
    await page.getByRole('tab', { name: 'Bring back' }).click()
    await page.getByRole('button', { name: 'All' }).click()
    await expect(page.getByText('You receive about')).toBeVisible()
    await page.getByRole('button', { name: 'Sign and move' }).click()
    await expect(page.getByText('Moved.')).toBeVisible({ timeout: 20_000 })
    expect(world.signed).toEqual(['MetaTransaction', 'Order'])
    const body = world.submitted[0]!.body
    expect(body.sellToken).toBe(GOLD.address)
    expect(body.sellAmount).toBe((2n * 10n ** 16n).toString())
    const hook = JSON.parse(body.appData as string).metadata.hooks.pre[0]
    const meta = decodeFunctionData({ abi: APPROVAL_ABI, data: hook.callData })
    expect(meta.functionName).toBe('executeMetaTransaction')
    const inner = decodeFunctionData({ abi: APPROVAL_ABI, data: meta.args![1] as `0x${string}` })
    expect(inner.args).toEqual([COW_VAULT_RELAYER, 2n * 10n ** 16n])
  })

  test('declining the signature in the wallet moves nothing', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    world.rejectNext = true
    await page.goto('./')
    await openGold(page, '25')
    await page.getByRole('button', { name: 'Sign and move' }).click()
    await expect(page.getByText('Signature declined in the wallet. Nothing moved.')).toBeVisible()
    expect(world.submitted).toHaveLength(0)
  })

  test('an amount above the balance is refused before any signature', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    await page.goto('./')
    await openGold(page, '500')
    await expect(page.getByRole('alert')).toHaveText('This is more than the wallet holds.')
    await expect(page.getByRole('button', { name: 'Sign and move' })).toBeDisabled()
    expect(world.signed).toEqual([])
  })

  test('a move under one dollar is refused', async ({ page }) => {
    await installWorld(page, { insidePay: true })
    await page.goto('./')
    await openGold(page, '0.5')
    await expect(page.getByRole('alert')).toHaveText('The smallest move is $1.')
  })

  test('an order no solver fills expires and says nothing moved', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    world.expire = true
    await page.goto('./')
    await openGold(page, '25')
    await page.getByRole('button', { name: 'Sign and move' }).click()
    await expect(page.getByText(/No solver filled the order before it expired\. Nothing moved\./)).toBeVisible({ timeout: 20_000 })
    expect(world.balances.gold).toBe(0n)
  })

  test('staking sends a new-staker transaction to the chosen pool', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    await page.goto('./')
    await page.getByRole('button', { name: /NIM that earns/ }).click()
    await expect(page.getByText('Harbour Pool')).toBeVisible()
    await expect(page.getByText('Low Trust Pool')).toHaveCount(0)
    await page.getByLabel(/Quay Pool/).check()
    await page.getByLabel('NIM to stake').fill('500')
    await page.getByRole('button', { name: 'Stake' }).click()
    await expect(page.getByText('Staked.')).toBeVisible()
    expect(world.staked).toEqual([
      { method: 'sendNewStakerTransaction', args: { delegation: 'NQ33 CCCC CCCC CCCC CCCC CCCC CCCC CCCC CCCC', value: 50_000_000 } },
    ])
    await expectAccessible(page)
  })

  test('a first stake under 100 NIM is refused', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true })
    await page.goto('./')
    await page.getByRole('button', { name: /NIM that earns/ }).click()
    await page.getByLabel('NIM to stake').fill('50')
    await page.getByRole('button', { name: 'Stake' }).click()
    await expect(page.getByRole('alert')).toHaveText('The smallest first stake is 100 NIM.')
    expect(world.staked).toEqual([])
  })

  test('activity lists the moves read from the order book', async ({ page }) => {
    await installWorld(page, { insidePay: true })
    await page.goto('./')
    await openGold(page, '25')
    await page.getByRole('button', { name: 'Sign and move' }).click()
    await expect(page.getByText('Moved.')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Activity' }).click()
    await expect(page.getByRole('link', { name: /25\.00 USDT → 0\.006\d+ PAXG/ })).toBeVisible()
    await expectAccessible(page)
  })
})

test.describe('when CoinGecko is rate limited', () => {
  test('prices come from the second source, the screen names it, and a move still settles', async ({ page }) => {
    const world = await installWorld(page, { insidePay: true, userFiat: 'EUR' })
    world.coinGeckoBusy = true
    await page.goto('./')
    await expect(page.getByText('Values use DefiLlama prices in EUR.')).toBeVisible()
    await openGold(page, '25')
    await expect(page.getByText('Against the DefiLlama price')).toBeVisible()
    await page.getByRole('button', { name: 'Sign and move' }).click()
    await expect(page.getByText('Moved.')).toBeVisible({ timeout: 20_000 })
  })
})
