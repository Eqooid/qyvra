import { DashboardShell } from "@/components/layout/dashboard-shell"
export const metadata = { title: "Dashboard | Brainless" }
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardShell>{children}</DashboardShell>
}
