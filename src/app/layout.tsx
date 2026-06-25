import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from '@/components/providers/theme-provider'

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "APSAMO Technology - Hosting & Domain Automation Platform",
  description: "APSAMO Technology — web development, hosting, domain registration, and SaaS platforms. Build, host, and scale your entire online presence.",
  keywords: ["APSAMO", "APSAMO Technology", "Web Development", "Hosting", "Domains", "Deployment", "SaaS", "Next.js"],
  authors: [{ name: "APSAMO Technology" }],
  icons: {
    icon: "/apsamo-favicon.svg",
  },
  openGraph: {
    title: "APSAMO Technology",
    description: "Hosting & Domain Automation Platform — build, host, and scale your online presence.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
