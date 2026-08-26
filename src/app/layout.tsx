import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

// Self-hosted via next/font/google — Next.js downloads these at build time and serves them from
// the app's own origin, so there is no runtime request to fonts.googleapis.com (matches the
// design's IBM Plex Sans/Mono pairing, T-02-08's "no third-party account/network dependency"
// posture extended to fonts).
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "KyzerDocs Lite",
  description: "Upload your documents, ask questions, get cited answers.",
};

/**
 * Root layout — just the HTML shell and self-hosted font variables now. The persistent product
 * chrome (232px dark sidebar, nav, stats) lives in `src/components/layout/AppShell.tsx`, rendered
 * by each authenticated screen (Documents, Chat) individually, matching the design template's
 * `grid-template-columns: 232px 1fr` structure. `/login` deliberately renders without it — there
 * is no session yet, so there is nothing for the sidebar's stats/nav to reflect.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
