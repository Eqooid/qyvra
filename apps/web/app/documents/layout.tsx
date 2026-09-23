import { DashboardShell } from "@/components/layout/dashboard-shell"
export const metadata = { title: "Documents | Brainless" }
export default function DocumentsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardShell>{children}</DashboardShell>
}
