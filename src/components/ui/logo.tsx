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
 * The Apsamo Technology "A" mark.
 * Two shapes: the dark indigo peak (left leg + apex, ending in a notched
 * shoulder on the right slope) and the periwinkle swoosh that sweeps from
 * the shared bottom-left tip and thickens into the A's right leg.
 */
export function LogoMark({ className }: LogoMarkProps) {
  return (
    <svg
      viewBox="0 0 736 736"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-8', className)}
      aria-hidden="true"
    >
      {/* dark peak: left leg + apex, notched right shoulder */}
      <path
        d="M132 592 C216 444 322 234 354 174 C364 154 382 154 392 174 L494 358 L452 318 L420 360 C340 330 224 470 132 592 Z"
        fill={BRAND_COLORS.navy}
      />
      {/* periwinkle swoosh + right leg */}
      <path
        d="M120 604 C250 472 396 398 508 388 L586 378 L602 392 C594 456 580 524 568 560 L484 572 L508 470 C380 452 240 520 120 604 Z"
        fill={BRAND_COLORS.indigo}
      />
    </svg>
  )
}

interface LogoProps {
  className?: string
  showSubtitle?: boolean
  subtitleClassName?: string
}

export function Logo({ className, showSubtitle = false, subtitleClassName }: LogoProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex size-9 items-center justify-center rounded-lg bg-white shadow-sm ring-1 ring-black/5">
        <LogoMark className="size-6" />
      </div>
      <div className="flex flex-col leading-none">
        <span className="text-lg font-extrabold tracking-tight text-foreground">Apsamo Technology</span>
        {showSubtitle && (
          <span className={cn('text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground', subtitleClassName)}>
            Technology
          </span>
        )}
      </div>
    </div>
  )
}
