import { DashboardShell } from "@/components/layout/dashboard-shell"
export const metadata = { title: "AI Search | QYVRA" }
export default function Layout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>
}
