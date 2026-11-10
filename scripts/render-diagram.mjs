// Renders docs/architecture.svg to docs/architecture.png at 2x.
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'

const svg = readFileSync(new URL('../docs/architecture.svg', import.meta.url), 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 860, height: 560 }, deviceScaleFactor: 2 })
await page.setContent(`<body style="margin:0">${svg}</body>`)
await page.screenshot({ path: 'docs/architecture.png' })
await browser.close()
