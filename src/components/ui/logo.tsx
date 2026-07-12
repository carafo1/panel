import { cn } from '@/lib/utils'

export const BRAND_COLORS = {
  navy: '#322D5E',
  indigo: '#7477DC',
  indigoDark: '#5D5CB8',
  indigoLight: '#8888FF',
} as const

interface LogoMarkProps {
  className?: string
}

/**
 * The Apsamo "A" icon mark — the exact brand artwork served from
 * /public/apsamo-icon.png. Used wherever an icon (not the full wordmark) is
 * needed: the auth modal, the dashboard sidebar, etc. object-contain keeps the
 * original aspect ratio so the shape is never distorted.
 */
export function LogoMark({ className }: LogoMarkProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/apsamo-icon.png"
      alt="Apsamo"
      className={cn('size-8 object-contain', className)}
    />
  )
}

interface LogoProps {
  className?: string
  showSubtitle?: boolean
  subtitleClassName?: string
}

/**
 * The full Apsamo Technology logo (mark + wordmark) — the exact brand artwork
 * served from /public/apsamo-logo.png. Used where the whole brand logo shows
 * (e.g. the landing header).
 */
export function Logo({ className }: LogoProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/apsamo-logo.png"
      alt="Apsamo Technology"
      className={cn('h-9 w-auto object-contain', className)}
    />
  )
}
