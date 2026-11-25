'use client'

import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface Choice<T extends string> {
  value: T
  title: string
  description?: ReactNode
  icon?: ReactNode
  /** Small trailing text, e.g. "Recommended" or a format list. */
  meta?: ReactNode
  disabled?: boolean
}

/**
 * A radio group drawn as selectable rows. Native radios underneath, so arrow
 * keys, Tab, labels and screen readers behave as they should; the row is the
 * visual and the click target.
 */
export function ChoiceList<T extends string>({
  name,
  legend,
  hideLegend,
  value,
  onChange,
  choices,
  columns = 1,
  children,
}: {
  name: string
  legend: string
  hideLegend?: boolean
  value: T | null
  onChange: (value: T) => void
  choices: Choice<T>[]
  columns?: 1 | 2
  /** Rendered under the selected row (e.g. its follow-up fields). */
  children?: (value: T) => ReactNode
}) {
  return (
    <fieldset className="min-w-0">
      <legend className={cn('mb-2 text-sm font-medium', hideLegend && 'sr-only')}>{legend}</legend>
      <div className={cn('grid gap-2', columns === 2 && 'sm:grid-cols-2')}>
        {choices.map((c) => {
          const selected = value === c.value
          return (
            <div key={c.value} className="min-w-0">
              <label
                className={cn(
                  'group relative flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 transition-colors duration-150',
                  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background',
                  selected ? 'border-primary bg-primary/[0.04]' : 'hover:border-primary/40',
                  c.disabled && 'cursor-not-allowed opacity-60 hover:border-border'
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={c.value}
                  checked={selected}
                  disabled={c.disabled}
                  onChange={() => onChange(c.value)}
                  className="sr-only"
                />
                {c.icon && (
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-md transition-colors',
                      selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {c.icon}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-sm font-medium">{c.title}</span>
                    {c.meta && <span className="text-xs text-muted-foreground">{c.meta}</span>}
                  </span>
                  {c.description && (
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                      {c.description}
                    </span>
                  )}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                    selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                  )}
                >
                  {selected && <Check className="size-3" strokeWidth={3} />}
                </span>
              </label>
              {selected && children && <div className="mt-2 ps-1">{children(c.value)}</div>}
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}

/** Labelled field wrapper with helper text and an inline error. */
export function Field({
  id,
  label,
  hint,
  error,
  optional,
  children,
}: {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  optional?: boolean
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {optional && <span className="ms-1.5 font-normal text-muted-foreground">(optional)</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** aria-describedby value matching what Field renders. */
export function describedBy(id: string, error?: string | null, hint?: ReactNode): string | undefined {
  if (error) return `${id}-error`
  if (hint) return `${id}-hint`
  return undefined
}

/** A folded section for options most people never need. */
export function MoreOptions({
  label = 'More options',
  open,
  onToggle,
  children,
}: {
  label?: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-start text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
        <span className="text-xs font-normal text-muted-foreground">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && <div className="space-y-4 border-t p-3">{children}</div>}
    </div>
  )
}
