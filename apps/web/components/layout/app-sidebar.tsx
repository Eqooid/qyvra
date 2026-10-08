"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Files,
  FolderOpen,
  LayoutDashboard,
  Tags,
  X,
  Search,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"

export function AppSidebar() {
  const pathname = usePathname()
  const { isMobile, state, setOpenMobile } = useSidebar()
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/dashboard" />}
              tooltip={!isMobile && state === "collapsed" ? "QYVRA" : undefined}
              onClick={() => setOpenMobile(false)}
            >
              <Files aria-hidden />
              <span className="font-semibold">QYVRA</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close navigation"
            onClick={() => setOpenMobile(false)}
          >
            <X aria-hidden />
          </Button>
        )}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav
              aria-label={isMobile ? "Mobile navigation" : "Main navigation"}
            >
              <SidebarMenu>
                {[
                  {
                    href: "/dashboard",
                    label: "Overview",
                    icon: LayoutDashboard,
                  },
                  { href: "/documents", label: "Documents", icon: Files },
                  { href: "/ai", label: "AI Search", icon: Search },
                  {
                    href: "/categories",
                    label: "Categories",
                    icon: FolderOpen,
                  },
                  { href: "/tags", label: "Tags", icon: Tags },
                ].map(({ href, label, icon: Icon }) => (
                  <SidebarMenuItem key={href}>
                    <SidebarMenuButton
                      render={<Link href={href} />}
                      tooltip={
                        !isMobile && state === "collapsed" ? label : undefined
                      }
                      isActive={
                        pathname === href || pathname.startsWith(`${href}/`)
                      }
                      aria-current={
                        pathname === href
                          ? "page"
                          : pathname.startsWith(`${href}/`)
                            ? "location"
                            : undefined
                      }
                      onClick={() => setOpenMobile(false)}
                    >
                      <Icon aria-hidden />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        <p className="text-xs text-muted-foreground">
          A little more order.
          <br />A little more peace of mind.
        </p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

export function NavigationTrigger() {
  const { isMobile, open, openMobile } = useSidebar()
  return (
    <SidebarTrigger
      aria-label={isMobile ? "Open navigation" : "Toggle sidebar"}
      aria-expanded={isMobile ? openMobile : open}
    />
  )
}
