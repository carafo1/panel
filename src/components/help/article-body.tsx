import ReactMarkdown from 'react-markdown'

/**
 * Renders a help article's Markdown. react-markdown ignores raw HTML by
 * default, so staff-written content cannot inject markup or script.
 */
export function ArticleBody({ markdown }: { markdown: string }) {
  return (
    <div className="space-y-4 text-[15px] leading-7 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[13px] [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:ps-6 [&_ul]:list-disc [&_ul]:ps-6">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => {
            const external = !!href && /^https?:\/\//.test(href)
            return (
              <a
                href={href}
                className="font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-700 dark:text-indigo-400"
                {...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}
              >
                {children}
              </a>
            )
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
