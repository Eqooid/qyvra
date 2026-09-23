import { DashboardShell } from "@/components/layout/dashboard-shell"
export const metadata = { title: "Tags | Brainless" }
export default function TagsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardShell>{children}</DashboardShell>
}
