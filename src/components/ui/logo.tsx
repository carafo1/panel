import { cn } from '@/lib/utils'

export const BRAND_COLORS = {
  navy: '#1E1A47',
  indigo: '#706FD3',
  indigoDark: '#5D5CB8',
  indigoLight: '#8888FF',
} as const

interface LogoMarkProps {
  className?: string
}

/** The APSAMO "A" mark — navy triangle peak + indigo swoosh. */
export function LogoMark({ className }: LogoMarkProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-8', className)}
      aria-hidden="true"
    >
      {/* navy triangle peak */}
      <path d="M24 6 L40 40 L8 40 Z" fill={BRAND_COLORS.navy} />
      {/* indigo swoosh */}
      <path
        d="M14 40 Q24 18 34 40"
        stroke={BRAND_COLORS.indigo}
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
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
        <span className="text-lg font-extrabold tracking-tight text-foreground">APSAMO</span>
        {showSubtitle && (
          <span className={cn('text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground', subtitleClassName)}>
            Technology
          </span>
        )}
      </div>
    </div>
  )
}
