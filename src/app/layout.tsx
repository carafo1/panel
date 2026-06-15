import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DeployHub - Hosting & Domain Automation Platform",
  description: "Modern hosting and domain management platform with automated deployments, DNS management, and billing.",
  keywords: ["DeployHub", "Next.js", "Hosting", "Domains", "Deployment", "Automation"],
  authors: [{ name: "DeployHub Team" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "DeployHub",
    description: "Hosting & Domain Automation Platform",
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
        {children}
        <Toaster />
      </body>
    </html>
  );
}
