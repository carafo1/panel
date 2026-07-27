'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent,
} from 'react'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ──────────────────────────────────────────────────────────────────────
 * useCountUp
 * Animates a number from 0 → target over `duration` ms (ease-out cubic),
 * starting the first time the returned ref scrolls into view.
 * ──────────────────────────────────────────────────────────────────── */
// Generic over the element it attaches to: React refs are invariant, so a
// RefObject<HTMLSpanElement> cannot be handed to a <p>. Callers that use a
// different tag pass it explicitly, e.g. useCountUp<HTMLParagraphElement>(…).
export function useCountUp<T extends HTMLElement = HTMLSpanElement>(
  target: number,
  duration = 1800
) {
  const [value, setValue] = useState(0)
  const ref = useRef<T>(null)
  const started = useRef(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    // Targets arrive asynchronously: site content is fetched after mount, so
    // the first render passes 0 for every stat. Arming the observer on that
    // placeholder latched `started` and animated 0 → 0; when the real value
    // landed the effect re-ran, but `started` was still true, so nothing ever
    // animated. The stats row sat permanently at "0+ Developers" and
    // "0% Uptime SLA" on the live home page.
    //
    // Two changes fix it: ignore a zero target, and re-arm whenever the target
    // actually changes. IntersectionObserver fires immediately on observe()
    // for an element already in view, so a late-arriving value animates rather
    // than waiting for another scroll.
    if (!target) return
    started.current = false

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting && !started.current) {
          started.current = true
          const startTime = performance.now()
          // Preserve one decimal for non-integer targets (e.g. 99.9 must not
          // round up to 100); integers stay whole.
          const decimals = Number.isInteger(target) ? 0 : 1
          const factor = decimals ? 10 : 1
          const tick = (now: number) => {
            const progress = Math.min((now - startTime) / duration, 1)
            const eased = 1 - Math.pow(1 - progress, 3)
            setValue(progress >= 1 ? target : Math.round(eased * target * factor) / factor)
            if (progress < 1) requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }
      },
      { threshold: 0.3 }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [target, duration])

  return { value, ref }
}

/* ──────────────────────────────────────────────────────────────────────
 * useSpotlight
 * Returns `[ref, onMouseMove]` — attach both to an element with the
 * `.spotlight` class and the radial glow follows the cursor.
 * ──────────────────────────────────────────────────────────────────── */
export function useSpotlight<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)

  const onMouseMove = useCallback((e: MouseEvent<T>) => {
    const node = ref.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    node.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`)
    node.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`)
  }, [])

  return { ref, onMouseMove }
}

/* ──────────────────────────────────────────────────────────────────────
 * ScrollProgress
 * Fixed 2px indigo gradient bar at the very top of the viewport that
 * tracks how far the user has scrolled down the page.
 * ──────────────────────────────────────────────────────────────────── */
export function ScrollProgress() {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const onScroll = () => {
      const scrollTop = window.scrollY
      const docHeight =
        document.documentElement.scrollHeight - window.innerHeight
      const pct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0
      setProgress(pct)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div
      className="scroll-progress"
      style={{ width: `${progress}%` }}
      aria-hidden="true"
    />
  )
}

/* ──────────────────────────────────────────────────────────────────────
 * ScrollReveal
 * Wraps children in a div that fades + slides up the first time it
 * enters the viewport (uses IntersectionObserver + `animate-fade-in-up`).
 * ──────────────────────────────────────────────────────────────────── */
interface ScrollRevealProps {
  children: ReactNode
  className?: string
  /** Delay in ms before the animation starts. */
  delay?: number
  /** Render as a different element (defaults to `div`). */
  as?: 'div' | 'section' | 'article' | 'li'
}

export function ScrollReveal({
  children,
  className,
  delay = 0,
  as = 'div',
}: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const Tag = as as 'div'
  return (
    <Tag
      ref={ref}
      className={cn(visible && 'animate-fade-in-up', className)}
      style={{
        opacity: visible ? undefined : 0,
        animationDelay: delay ? `${delay}ms` : undefined,
      }}
    >
      {children}
    </Tag>
  )
}

/* ──────────────────────────────────────────────────────────────────────
 * StaggerCard
 * ScrollReveal variant with an `index` prop — each card in a grid waits
 * a little longer so the items appear in sequence.
 * ──────────────────────────────────────────────────────────────────── */
interface StaggerCardProps {
  children: ReactNode
  className?: string
  index?: number
  as?: 'div' | 'section' | 'article' | 'li'
}

export function StaggerCard({
  children,
  className,
  index = 0,
  as = 'div',
}: StaggerCardProps) {
  return (
    <ScrollReveal
      as={as}
      className={className}
      delay={index * 100}
    >
      {children}
    </ScrollReveal>
  )
}

/* ──────────────────────────────────────────────────────────────────────
 * PageHero
 * Standard hero used at the top of every public sub-page (services,
 * pricing, about, contact). Aurora-bg navy with grain + dot grid.
 * ──────────────────────────────────────────────────────────────────── */
interface PageHeroProps {
  title: ReactNode
  subtitle?: ReactNode
  badge?: string
}

export function PageHero({ title, subtitle, badge }: PageHeroProps) {
  return (
    <section
      className="aurora-bg grain-overlay relative overflow-hidden"
      style={{ backgroundColor: '#1E1A47' }}
    >
      {/* aurora blobs */}
      <div
        className="aurora-blob aurora-blob-1"
        style={{
          width: 480,
          height: 480,
          top: -120,
          right: -80,
          background: '#706FD3',
        }}
      />
      <div
        className="aurora-blob aurora-blob-2"
        style={{
          width: 420,
          height: 420,
          bottom: -120,
          left: -100,
          background: '#8888FF',
        }}
      />
      <div
        className="aurora-blob"
        style={{
          width: 360,
          height: 360,
          top: '40%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: '#5D5CB8',
          opacity: 0.35,
        }}
      />

      {/* dotted grid overlay */}
      <div
        className="dot-grid absolute inset-0 z-[1] opacity-50"
        aria-hidden="true"
      />

      <div className="relative z-[2] mx-auto max-w-5xl px-6 py-24 text-center sm:py-28">
        {badge && (
          <div className="mb-6 inline-flex items-center gap-2 rounded-full glass px-4 py-1.5 text-xs font-medium text-indigo-100 shadow-glow-indigo animate-fade-in-up">
            <Sparkles className="size-3.5 text-indigo-300" />
            <span>{badge}</span>
          </div>
        )}
        <h1
          className="animate-fade-in-up text-balance text-4xl font-extrabold tracking-tight text-white sm:text-5xl md:text-6xl"
          style={{ animationDelay: '60ms' }}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            className="animate-fade-in-up mx-auto mt-5 max-w-2xl text-pretty text-base text-zinc-300 sm:text-lg"
            style={{ animationDelay: '120ms' }}
          >
            {subtitle}
          </p>
        )}
      </div>
    </section>
  )
}
