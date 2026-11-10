// Prints the coverage of the decision core as a Markdown table for the CI run page.
import { readFileSync } from 'node:fs'

const summary = JSON.parse(readFileSync(new URL('../coverage/coverage-summary.json', import.meta.url), 'utf8'))
console.log('## Decision core coverage\n')
console.log('| Module | Lines | Branches |')
console.log('|---|---|---|')
for (const [file, data] of Object.entries(summary)) {
  const name = file === 'total' ? '**Total**' : file.replace(/\/g, '/').split('/src/')[1]
  console.log(`| ${name} | ${data.lines.pct}% | ${data.branches.pct}% |`)
}
