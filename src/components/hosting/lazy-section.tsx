'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A website-management section that mounts its content only once it comes
 * near the viewport (or is jumped to from the sub-tab bar), then keeps it.
 *
 * The website page renders every management section on one long page. Each
 * section fetches its own data on mount, so opening a website used to fire
 * ~20 requests at once — including opening a terminal session — and any
 * section's error (e.g. "no domain yet — add a domain before managing
 * email") popped up as a toast on the Overview. Mounting on approach keeps
 * the page fast and errors where the customer is looking.
 */
export function LazySection({
  id,
  className = '',
  minHeight = 160,
  children,
}: {
  id: string
  className?: string
  minHeight?: number
  children: ReactNode
}) {
  const ref = useRef<HTMLElement | null>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (shown) return
    const el = ref.current
    if (!el) return
    // Jumping straight to the section (#files) or no observer support: show now.
    if (typeof IntersectionObserver === 'undefined' || window.location.hash === `#${id}`) {
      setShown(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true)
          io.disconnect()
        }
      },
      { rootMargin: '300px 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [id, shown])

  return (
    <section
      id={id}
      ref={ref}
      className={`scroll-mt-32 ${className}`.trim()}
      style={shown ? undefined : { minHeight }}
      aria-busy={!shown}
    >
      {shown ? children : null}
    </section>
  )
}
