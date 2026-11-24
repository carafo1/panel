/**
 * Next.js startup hook — runs once when the server process starts.
 *
 * Customer cron jobs run on the panel's in-process scheduler (node-cron),
 * which used to start only on the first use of a Cron tab. After every panel
 * restart or deploy, no customer cron job fired until somebody happened to
 * open that tab. Start it at boot instead.
 *
 * Delayed slightly and not awaited, so a slow database never holds up the
 * server accepting requests; startCronScheduler is idempotent and never
 * throws.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Dynadot keys saved in Admin (encrypted in the database) override .env.
  try {
    const { applyDynadotSettings } = await import('./lib/dynadot-settings')
    await applyDynadotSettings()
  } catch (err) {
    console.error('[instrumentation] loading Dynadot settings failed:', err)
  }

  // Site imports run inside this process: one that was running when the
  // previous process stopped (a deploy, a crash) is restarted now instead of
  // sitting at "running" until a sweep fails it hours later.
  setTimeout(() => {
    import('./lib/migration/resume')
      .then(({ resumeInterruptedMigrations }) => resumeInterruptedMigrations())
      .then((n) => {
        if (n > 0) console.log(`[instrumentation] resumed ${n} interrupted site import(s)`)
      })
      .catch((err) => console.error('[instrumentation] resuming site imports failed:', err))
  }, 8000)

  if (process.env.DISABLE_CRON_SCHEDULER === '1') return

  setTimeout(() => {
    import('./lib/vps/cron')
      .then(({ startCronScheduler }) => startCronScheduler())
      .catch((err) => console.error('[instrumentation] cron scheduler failed to start:', err))
  }, 3000)
}
