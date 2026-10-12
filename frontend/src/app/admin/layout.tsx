import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin-nav";

/**
 * The single admin entry point. `/admin` and everything nested under it share
 * this shell, so navigation, spacing, and identity are defined once.
 *
 * Deliberately NOT an authorization boundary: staff membership is enforced
 * server-side by `staff_admins` behind `CurrentStaffUserDep`. Each page still
 * handles its own 401/403 response, which is what actually protects the data.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}