/**
 * Billing preview — READ ONLY. Changes nothing, sends nothing.
 *
 * Shows what the next billing sweep would do to each customer: raise a
 * renewal invoice, mark past due (warning email, still online), suspend
 * (websites stopped, mail paused) or finish a scheduled cancellation.
 *
 * Run it on the server BEFORE restarting the panel/worker on new billing
 * rules, so anyone listed who has in fact paid (e.g. a bank transfer never
 * marked paid) can be fixed in Admin → Invoices first:
 *
 *   cd /opt/apsamo && bun run scripts/billing-preview.ts
 *   bun run scripts/billing-preview.ts --json      # machine-readable
 *
 * Uses the same rules as the sweep itself (lib/billing-enforcement), so what
 * it prints is what the sweep will do at this moment. Stripe-billed
 * subscriptions are not listed: Stripe drives those through its webhooks.
 */
import { db } from '../src/lib/db'
import { previewEnforcement, type PreviewRow } from '../src/lib/billing-enforcement'

const JSON_OUT = process.argv.includes('--json')
// --out <file>: write the JSON to a file instead of stdout. update.sh uses it so
// unrelated log lines (e.g. the DB layer's startup PRAGMA messages) can never
// corrupt the JSON it parses — that used to hold the worker after every update.
const OUT_INDEX = process.argv.indexOf('--out')
const OUT_FILE = OUT_INDEX > -1 ? process.argv[OUT_INDEX + 1] : undefined

const LABEL: Record<PreviewRow['action'], string> = {
  suspend: 'SUSPEND — websites stopped, mail paused',
  end_cancelled: 'END CANCELLED PLAN — websites stopped',
  past_due: 'PAST DUE — warning email, still online',
  renew: 'RENEW — new invoice raised and emailed',
}
const ORDER: PreviewRow['action'][] = ['suspend', 'end_cancelled', 'past_due', 'renew']

async function main() {
  const rows = await previewEnforcement()

  if (JSON_OUT || OUT_FILE) {
    const json = JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)
    if (OUT_FILE) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(OUT_FILE, json)
    } else {
      console.log(json)
    }
    return
  }

  console.log(`\nBilling preview — ${new Date().toUTCString()}  (read only, nothing changed)\n`)
  if (rows.length === 0) {
    console.log('Nothing to do: no customer would be renewed, warned or suspended right now.\n')
    return
  }

  for (const action of ORDER) {
    const group = rows.filter((r) => r.action === action)
    if (group.length === 0) continue
    console.log(`${LABEL[action]}  (${group.length})`)
    for (const r of group) {
      const who = r.email ? `${r.name ?? ''} <${r.email}>`.trim() : r.userId
      const money = r.invoiceNumber ? `  ${r.invoiceNumber} ${r.amountDue ?? ''} due ${r.dueDate ?? '?'}` : ''
      const sites = r.websitesAffected ? `  [${r.websitesAffected} website(s) go offline]` : ''
      console.log(`  - ${who} · ${r.plan} (${r.status})${money}${sites}`)
      console.log(`      ${r.reason}`)
    }
    console.log('')
  }

  const sites = rows.reduce((n, r) => n + r.websitesAffected, 0)
  console.log(
    `Totals: suspend ${rows.filter((r) => r.action === 'suspend').length}, ` +
      `end cancelled ${rows.filter((r) => r.action === 'end_cancelled').length}, ` +
      `past due ${rows.filter((r) => r.action === 'past_due').length}, ` +
      `renew ${rows.filter((r) => r.action === 'renew').length}; websites going offline: ${sites}\n`
  )
  console.log('If anyone above has actually paid, mark their invoice paid in Admin → Invoices')
  console.log('(that also reactivates them), then run this again before restarting the services.\n')
}

main()
  .catch((err) => {
    console.error('billing-preview failed:', err)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
