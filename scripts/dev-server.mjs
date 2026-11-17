/**
 * Start `next dev` from the project folder, whatever directory the launcher
 * was started in. next-intl's Turbopack integration resolves its config path
 * (./src/i18n/request.ts) from the process working directory, so starting
 * from a parent folder fails with "Could not find i18n config".
 *
 *   node scripts/dev-server.mjs [port]
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const port = process.argv[2] || process.env.PORT || '3000'
const nextBin = path.join(root, 'node_modules/next/dist/bin/next')
process.argv = [process.argv[0], nextBin, 'dev', '-p', String(port)]
await import(pathToFileURL(nextBin).href)
