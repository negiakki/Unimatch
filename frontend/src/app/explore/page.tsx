import type { Metadata } from "next";

import { AppNav, TAB_BAR_SPACE } from "@/components/app-nav";

import { ExploreClient } from "./explore-client";

export const metadata: Metadata = {
  title: "Discover",
  description:
    "Browse opportunities happening at your university — sports, events, concerts, movie nights and more. Join one, then find your partner.",
};

/**
 * /explore — the signed-in entry point. Discovery starts with WHAT the user is
 * doing, so this page is organised around opportunities and categories, never
 * around a global stream of people.
 */
export default function ExplorePage() {
  return (
    <>
      <AppNav />
      <main className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${TAB_BAR_SPACE}`}>
        <ExploreClient />
      </main>
    </>
  );
}