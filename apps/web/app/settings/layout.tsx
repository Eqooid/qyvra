import { DashboardShell } from "@/components/layout/dashboard-shell"
export const metadata = { title: "Account settings | Brainless" }
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardShell>{children}</DashboardShell>
}
