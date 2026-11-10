// Renders the link card, the app icon and the thumbnail from one HTML template.
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const octagon = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 48 48"><path d="M15 4h18l11 11v18L33 44H15L4 33V15z" fill="#e3bd62"/><text x="24" y="32" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="700" fill="#1b1608">C</text></svg>`
const punch = (shape, fill, glyph, fs) => `<svg width="96" height="96" viewBox="0 0 48 48">${shape.replace('FILL', fill)}<text x="24" y="${24 + fs * 0.36}" text-anchor="middle" font-family="Georgia, serif" font-size="${fs}" font-weight="700" fill="#1b1608">${glyph}</text></svg>`
const marks = [
  punch('<ellipse cx="24" cy="24" rx="22" ry="15" fill="FILL"/>', '#e3bd62', 'Au', 16),
  punch('<path d="M6 8h36v18c0 9-8 14-18 18C14 40 6 35 6 26z" fill="FILL"/>', '#a9c6f5', '€', 20),
  punch('<rect x="6" y="6" width="36" height="36" rx="3" fill="FILL"/>', '#f2a65a', '₿', 20),
].join('')

const card = `<body style="margin:0;width:1200px;height:630px;background:#0b241d;color:#f2f5f1;font-family:Georgia,serif;display:flex;flex-direction:column;justify-content:center;padding:0 90px;box-sizing:border-box">
<div style="display:flex;align-items:center;gap:28px">${octagon(120)}<div style="font-size:120px;letter-spacing:.03em">Coffer</div></div>
<div style="font-family:system-ui,sans-serif;font-size:46px;margin-top:34px;line-height:1.25">Hold gold, euros and bitcoin in Nimiq Pay.</div>
<div style="font-family:system-ui,sans-serif;font-size:30px;margin-top:18px;color:#b4c7bd">You sign, a solver pays the gas. No POL needed.</div>
<div style="display:flex;gap:26px;margin-top:44px">${marks}</div></body>`
const icon = (size) => `<body style="margin:0;width:${size}px;height:${size}px;background:#0b241d;display:flex;align-items:center;justify-content:center">${octagon(Math.round(size * 0.78))}</body>`

const out = process.argv[2] ?? 'public'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
for (const [name, html, w, h] of [
  ['og.png', card, 1200, 630],
  ['icon-512.png', icon(512), 512, 512],
  ['thumbnail-240.png', icon(240), 240, 240],
]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.setContent(html)
  await page.screenshot({ path: `${out}/${name}` })
  await page.close()
}
await browser.close()
