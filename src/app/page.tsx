import { headers } from 'next/headers'
import HomeClient from './home-client'

/**
 * Server entry for `/`.
 *
 * Detects the panel host from the request `Host` header and passes it to the
 * client app, so `panel.apsamo.com` renders the login screen on the FIRST paint
 * (no marketing flash) while the brand apex (`apsamo.com`) renders the website.
 * The client re-confirms the host after mount as a fallback.
 */
export default async function Page() {
  const hdrs = await headers()
  const host = (hdrs.get('host') || '').toLowerCase().split(':')[0]
  let panelHost = ''
  try {
    panelHost = new URL(
      process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || ''
    ).hostname.toLowerCase()
  } catch {
    /* APP_URL not set / malformed — treat as non-panel */
  }
  const isPanelHost = !!panelHost && host === panelHost
  return <HomeClient initialPanelHost={isPanelHost} />
}
