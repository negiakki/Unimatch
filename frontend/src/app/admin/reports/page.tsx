import type { Metadata } from "next";

import { AdminReportsList } from "./reports-list";

export const metadata: Metadata = {
  title: "Reports · UniMatch",
  description:
    "Review user reports as a UniMatch staff reviewer (read-only in v1).",
};

export default function AdminReportsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-16">
      <AdminReportsList />
    </main>
  );
}
