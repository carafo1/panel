import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Logo } from '@/components/ui/logo'
import { LanguageSwitcher } from '@/components/ui/language-switcher'

export async function HelpShell({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('shell')
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Link href="/" aria-label="Home">
            <Logo className="h-7" />
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/help" className="hover:text-foreground">
              {t('helpCenter')}
            </Link>
            <Link href="/status" className="hover:text-foreground">
              {t('systemStatus')}
            </Link>
            <LanguageSwitcher compact />
          </nav>
        </div>
        {children}
      </div>
    </main>
  )
}
