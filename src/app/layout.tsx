import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Noto_Sans_Arabic } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { dirFor, isLocale, DEFAULT_LOCALE } from "@/i18n/config";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from '@/components/providers/theme-provider'

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Geist has no Arabic glyphs; this one is used for Arabic text.
const notoArabic = Noto_Sans_Arabic({
  variable: "--font-arabic",
  subsets: ["arabic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Apsamo Technology - Hosting & Domain Automation Platform",
  description: "Apsamo Technology — web development, hosting, domain registration, and SaaS platforms. Build, host, and scale your entire online presence.",
  keywords: ["Apsamo Technology", "Web Development", "Hosting", "Domains", "Deployment", "SaaS", "Next.js"],
  authors: [{ name: "Apsamo Technology" }],
  icons: {
    icon: "/apsamo-icon.png",
    apple: "/apsamo-icon.png",
  },
  openGraph: {
    title: "Apsamo Technology",
    description: "Hosting & Domain Automation Platform — build, host, and scale your online presence.",
    type: "website",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Per-request CSP nonce set by src/proxy.ts. Next.js stamps it on its own
  // scripts; the theme script from next-themes needs it passed explicitly.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  return (
    <html lang={locale} dir={dirFor(locale)} suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${notoArabic.variable} antialiased bg-background text-foreground`}
      >
        <NextIntlClientProvider>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange nonce={nonce}>
            {children}
            <Toaster position={dirFor(locale) === "rtl" ? "bottom-left" : "bottom-right"} />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
