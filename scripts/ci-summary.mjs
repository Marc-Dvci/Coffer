// Prints the test counts and the coverage of the decision core as Markdown for the CI run page.
import { existsSync, readFileSync } from 'node:fs'

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

if (existsSync(new URL('../coverage/unit-results.json', import.meta.url))) {
  const unit = read('../coverage/unit-results.json')
  console.log('## Unit tests\n')
  console.log('| Passed | Failed | Skipped |')
  console.log('|---|---|---|')
  console.log(`| ${unit.numPassedTests} | ${unit.numFailedTests} | ${unit.numPendingTests} |\n`)
}

const summary = read('../coverage/coverage-summary.json')
console.log('## Decision core coverage\n')
console.log('| Module | Lines | Branches |')
console.log('|---|---|---|')
for (const [file, data] of Object.entries(summary)) {
  const name = file === 'total' ? '**Total**' : file.replaceAll('\\', '/').split('/src/')[1]
  console.log(`| ${name} | ${data.lines.pct}% | ${data.branches.pct}% |`)
}
