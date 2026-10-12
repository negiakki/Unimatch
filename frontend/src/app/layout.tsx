import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Fraunces, Geist } from "next/font/google";

import "./globals.css";

/**
 * Type pairing: Fraunces carries the display voice (oversized editorial
 * statements), Geist handles all UI and body copy. Two faces, one identity.
 */
const geistSans = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

const display = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "UniMatch — Find your people for whatever you're doing",
    template: "%s · UniMatch",
  },
  description:
    "Find your people for whatever you're doing. Join sports, events, concerts, movie nights and campus life — then meet the people going too. Verified university students only.",
  applicationName: "UniMatch",
};

export const viewport: Viewport = {
  themeColor: "#0c0c0e",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${display.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}