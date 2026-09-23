"use client"
import { Spinner } from "@/components/ui/spinner"

import { Alert } from "@/components/ui/alert"

import Link from "next/link"
import { useRouter, usePathname } from "next/navigation"
import { useEffect, useState } from "react"
import { LogOut, UserRound, ChevronDown } from "lucide-react"
import { AppSidebar, NavigationTrigger } from "./app-sidebar"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { useCurrentUser, useLogout } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser()
  const router = useRouter()
  const pathname = usePathname()
  const logout = useLogout()
  const [leaving, setLeaving] = useState(false)
  const [logoutError, setLogoutError] = useState<string>()
  useEffect(() => {
    if (user.isSuccess && user.data === null) router.replace("/login")
  }, [user.isSuccess, user.data, router])
  if (user.isError)
    return (
      <main className="mx-auto max-w-lg space-y-4 px-6 py-24">
        <h1 className="text-2xl font-semibold tracking-tight">
          Unable to load your workspace
        </h1>
        <Alert variant="destructive" role="alert">
          {user.error instanceof ApiError
            ? user.error.message
            : "Please try again."}
        </Alert>
        <Button onClick={() => void user.refetch()} disabled={user.isFetching}>
          Try again
        </Button>
        <Link href="/login" className="ml-4 text-primary underline">
          Log in
        </Link>
      </main>
    )
  if (user.isPending || !user.data)
    return (
      <main className="flex min-h-svh items-center justify-center">
        <p role="status" className="text-muted-foreground">
          <Spinner aria-hidden className="mr-2 inline size-4" />
          Checking your session…
        </p>
      </main>
    )
  async function leave() {
    setLeaving(true)
    setLogoutError(undefined)
    try {
      await logout()
    } catch {
      setLogoutError("Logout could not be confirmed. Please try again.")
      setLeaving(false)
    }
  }
  return (
    <TooltipProvider>
      <SidebarProvider>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-background focus:p-4"
        >
          Skip to content
        </a>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <header className="flex min-h-18 items-center justify-between gap-3 border-b bg-background px-4 sm:px-8">
            <div className="flex min-w-0 items-center gap-2">
              <NavigationTrigger />
              <span className="truncate text-sm font-medium">
                {pathname.startsWith("/documents")
                  ? "Documents"
                  : "Your workspace"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ThemeToggle />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      aria-label="Account menu"
                      className="gap-2"
                    />
                  }
                >
                  <Avatar>
                    <AvatarFallback>
                      <UserRound aria-hidden />
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden max-w-32 truncate sm:inline">
                    {user.data.displayName || "Account"}
                  </span>
                  <ChevronDown aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64 max-w-[90vw]">
                  <div className="mb-1 border-b px-3 py-3 text-sm">
                    <p className="font-medium break-words">
                      {user.data.displayName || "Your account"}
                    </p>
                    <p className="mt-1 break-all text-muted-foreground">
                      {user.data.email}
                    </p>
                  </div>
                  <DropdownMenuItem
                    render={<Link href="/settings" />}
                    className="min-h-11 px-3"
                  >
                    <UserRound aria-hidden />
                    Account settings
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={leaving}
                    onClick={() => void leave()}
                    className="min-h-11 px-3"
                  >
                    <LogOut aria-hidden />
                    {leaving ? "Logging out…" : "Log out"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <div
            id="main-content"
            tabIndex={-1}
            className="mx-auto w-full max-w-6xl min-w-0 space-y-8 px-4 py-8 sm:px-8 lg:px-10"
          >
            {logoutError && (
              <Alert
                variant="destructive"
                role="alert"
                className="text-sm text-destructive"
              >
                {logoutError}
              </Alert>
            )}
            {pathname === "/dashboard" && (
              <section>
                <p className="mb-2 text-xs font-medium tracking-widest text-primary uppercase">
                  Overview
                </p>
                <h1 className="text-3xl font-semibold tracking-tight break-words sm:text-4xl">
                  Welcome
                  {user.data.displayName
                    ? `, ${user.data.displayName}`
                    : " to your workspace"}
                  .
                </h1>
                <p className="mt-3 break-all text-muted-foreground">
                  {user.data.email}
                </p>
              </section>
            )}
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
