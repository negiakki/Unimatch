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
  title: "UniMatch",
  description:
    "Dating for university students. Real people, verified students only.",
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