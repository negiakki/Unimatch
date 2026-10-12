import type { Metadata } from "next";

import { VerificationQueue } from "./verification-queue";

export const metadata: Metadata = {
  title: "Verification queue · UniMatch",
  description:
    "Review pending student verification submissions as a UniMatch staff reviewer.",
};

export default function AdminVerificationsPage() {
  return <VerificationQueue />;
}