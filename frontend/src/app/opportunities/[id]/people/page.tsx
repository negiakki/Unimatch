import type { Metadata } from "next";

import { PeopleDiscovery } from "./people-discovery";

export const metadata: Metadata = {
  title: "Find your partner",
  description:
    "Discover the students who applied for the same opportunity, and find someone to do it with.",
};

/**
 * /opportunities/[id]/people — contextual people discovery.
 *
 * There is no global profile feed in V1: discovery only ever happens inside an
 * opportunity, so this route is always nested under one. The opportunity
 * context stays visible above the deck and returns in the match moment.
 */
export default async function PeoplePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-5 pb-10">
      <PeopleDiscovery opportunityId={id} />
    </main>
  );
}