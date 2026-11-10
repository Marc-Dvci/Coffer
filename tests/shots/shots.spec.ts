import { test } from '@playwright/test'
import { installWorld } from '../e2e/world'

/** Captures the screens shown in the README. Run with `npm run shots`. */
const OUT = 'docs'

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })

test('screens', async ({ page }) => {
  const world = await installWorld(page, { insidePay: true, userFiat: 'EUR' })
  world.balances = { usdt: 240_000_000n, gold: 5n * 10n ** 16n, euro: 150n * 10n ** 18n, bitcoin: 120_000n }
  world.pollsBeforeFill = 1
  await page.goto('./')
  await page.getByText('each').first().waitFor()
  await page.screenshot({ path: `${OUT}/screen-1-statement.png` })

  await page.getByRole('button', { name: /Gold/ }).click()
  await page.getByLabel('USDT to turn into gold').fill('50')
  await page.getByText('You receive about').waitFor()
  await page.locator('#quote').scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollTo(0, 430))
  await page.screenshot({ path: `${OUT}/screen-2-quote.png` })

  await page.getByRole('button', { name: 'Sign and move' }).click()
  await page.getByText('A solver settles the order on Polygon').waitFor()
  await page.waitForTimeout(600)
  await page.evaluate(() => window.scrollTo(0, 380))
  await page.screenshot({ path: `${OUT}/screen-3-signing.png` })

  await page.getByText('Moved.').waitFor({ timeout: 20_000 })
  await page.evaluate(() => window.scrollTo(0, 430))
  await page.screenshot({ path: `${OUT}/screen-4-receipt.png` })

  await page.getByRole('button', { name: 'Coffer, statement' }).click()
  await page.getByRole('button', { name: /NIM that earns/ }).click()
  await page.getByText('Harbour Pool').waitFor()
  await page.getByLabel('NIM to stake').fill('1000')
  await page.screenshot({ path: `${OUT}/screen-5-staking.png` })
})
