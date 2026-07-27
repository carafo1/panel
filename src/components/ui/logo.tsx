import { cn } from '@/lib/utils'

export const BRAND_COLORS = {
  navy: '#322D5E',
  indigo: '#7477DC',
  indigoDark: '#5D5CB8',
  indigoLight: '#8888FF',
} as const

/**
 * Reverse the brand artwork to solid white.
 *
 * The logo is a raster PNG, so its colours cannot be restyled the way an SVG's
 * fills can. It is two-tone — a dark navy wordmark (rgb 32,32,64) plus an
 * indigo mark (rgb 128,96,224) — and contains no light pixels at all, so on a
 * dark surface the wordmark effectively disappears.
 *
 * `brightness-0` drives every opaque pixel to black and `invert` flips it to
 * white, with the alpha channel untouched — the standard way to produce a
 * reversed logo from dark artwork. It does flatten the indigo accent into the
 * same white, which is inherent to recolouring a raster and is exactly what a
 * monochrome reversed logo is meant to look like.
 *
 * If you later want the indigo mark preserved on dark backgrounds, that needs a
 * second artwork file (e.g. /apsamo-logo-white.png) rather than a filter.
 */
const REVERSED = 'brightness-0 invert'

interface LogoMarkProps {
  className?: string
  /**
   * Force the white treatment regardless of theme — for a logo sitting on a
   * dark section (the hero, a dark footer) while the page is in light mode.
   * Omit it and the logo reverses automatically in dark mode only.
   */
  onDark?: boolean
}

/**
 * The Apsamo "A" icon mark — the exact brand artwork served from
 * /public/apsamo-icon.png. Used wherever an icon (not the full wordmark) is
 * needed: the auth modal, the dashboard sidebar, etc. object-contain keeps the
 * original aspect ratio so the shape is never distorted.
 */
export function LogoMark({ className, onDark }: LogoMarkProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/apsamo-icon.png"
      alt="Apsamo"
      className={cn(
        'size-8 object-contain',
        onDark ? REVERSED : 'dark:brightness-0 dark:invert',
        className
      )}
    />
  )
}

interface LogoProps {
  className?: string
  showSubtitle?: boolean
  subtitleClassName?: string
  /** See LogoMark.onDark. */
  onDark?: boolean
}

/**
 * The full Apsamo Technology logo (mark + wordmark) — the exact brand artwork
 * served from /public/apsamo-logo.png. Used where the whole brand logo shows
 * (e.g. the landing header).
 */
export function Logo({ className, onDark }: LogoProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/apsamo-logo.png"
      alt="Apsamo Technology"
      className={cn(
        'h-9 w-auto object-contain',
        onDark ? REVERSED : 'dark:brightness-0 dark:invert',
        className
      )}
    />
  )
}
