import type { Metadata } from "next";

import { AppNav, TAB_BAR_SPACE } from "@/components/app-nav";

import { OpportunityView } from "./opportunity-view";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  // Title/description stay generic per surface: the opportunity title is only
  // known after the client fetch, and a wrong cached title would be worse.
  void params;
  return {
    title: "Opportunity",
    description:
      "Join this opportunity, then discover the students who are going too.",
  };
}

/**
 * /opportunities/[id] — the hub of the product. Everything a student does
 * starts here: read about the opportunity, join it, then find a partner for
 * it. The page is laid out as an event page rather than a record, and the
 * primary CTA always states the next step.
 */
export default async function OpportunityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <AppNav />
      <main className={`flex-1 ${TAB_BAR_SPACE}`}>
        <OpportunityView opportunityId={id} />
      </main>
    </>
  );
}