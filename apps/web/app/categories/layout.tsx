import { DashboardShell } from "@/components/layout/dashboard-shell"
export const metadata = { title: "Categories | Brainless" }
export default function CategoriesLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardShell>{children}</DashboardShell>
}
