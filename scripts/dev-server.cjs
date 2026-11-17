/**
 * Start `next dev` from the project folder, whatever directory the launcher
 * was started in. next-intl's Turbopack integration resolves its config path
 * (./src/i18n/request.ts) from the process working directory, so starting
 * from a parent folder fails with "Could not find i18n config".
 *
 *   node scripts/dev-server.cjs [port]
 */
const path = require('path')

const root = path.resolve(__dirname, '..')
process.chdir(root)
const port = process.argv[2] || process.env.PORT || '3000'
process.argv = [process.argv[0], path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(port)]
require(path.join(root, 'node_modules/next/dist/bin/next'))
