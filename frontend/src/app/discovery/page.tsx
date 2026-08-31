import type { Metadata } from "next";

import { AppHeader } from "@/components/app-header";

import { DiscoveryFeed } from "./discovery-feed";

export const metadata: Metadata = {
  title: "Discover · UniMatch",
  description:
    "Meet verified university students on UniMatch. Every profile you see has passed student ID verification.",
};

export default function DiscoveryPage() {
  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-lg px-5 pb-16">
        <DiscoveryFeed />
      </main>
    </>
  );
}
