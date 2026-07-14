'use client'

import { PageHero } from '../ui-helpers'
import { useSiteContent } from '../site-data-context'

/**
 * Generic legal page (Privacy Policy / Terms of Service). Title, "last updated"
 * date, and full body are admin-editable content (Admin → Pages → Legal Pages).
 * Body format: blank line = new paragraph; a line starting with "## " renders
 * as a section heading.
 */
export function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const { getContent } = useSiteContent()
  const title = getContent(`legal.${kind}.title`)
  const updated = getContent(`legal.${kind}.updated`).trim()
  const blocks = getContent(`legal.${kind}.body`)
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)

  return (
    <>
      <PageHero
        title={<span className="text-gradient-brand">{title}</span>}
        subtitle={updated ? `Last updated: ${updated}` : ''}
      />
      <section className="py-16 bg-background">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          {blocks.map((block, i) => {
            if (block.startsWith('## ')) {
              const [headingLine, ...rest] = block.split('\n')
              const body = rest.join('\n').trim()
              return (
                <div key={i}>
                  <h2 className="text-xl font-bold tracking-tight mt-10 mb-3">{headingLine.slice(3).trim()}</h2>
                  {body && (
                    <p className="mb-4 text-sm sm:text-base leading-relaxed text-muted-foreground">{body}</p>
                  )}
                </div>
              )
            }
            return (
              <p key={i} className="mb-4 text-sm sm:text-base leading-relaxed text-muted-foreground">
                {block}
              </p>
            )
          })}
        </div>
      </section>
    </>
  )
}
