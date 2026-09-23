"use client"

import { createContext, useContext, useEffect, useState } from "react"
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { usePathname, useRouter } from "next/navigation"
import { AuthApi } from "@/lib/api/client"
const ApiContext = createContext<AuthApi | null>(null)
export const userKey = ["authenticated-user"] as const
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      })
  )
  const [api] = useState(() => new AuthApi())
  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
    </QueryClientProvider>
  )
}
export function useAuthApi() {
  const api = useContext(ApiContext)
  if (!api) throw new Error("Authentication provider is missing")
  return api
}
export function notifyAuthChange(kind: "login" | "logout" = "login") {
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("document-tracker-auth")
    channel.postMessage(kind)
    channel.close()
  }
}
export function useCurrentUser() {
  const api = useAuthApi()
  const cache = useQueryClient()
  const pathname = usePathname()
  const query = useQuery({
    queryKey: userKey,
    queryFn: () => api.currentUser(),
    enabled:
      pathname.startsWith("/dashboard") ||
      pathname === "/settings" ||
      pathname === "/categories" ||
      pathname === "/tags" ||
      pathname === "/documents" ||
      pathname.startsWith("/documents/"),
    staleTime: 0,
    refetchInterval: 60000,
    refetchOnWindowFocus: "always",
    retry: false,
  })
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return
    const channel = new BroadcastChannel("document-tracker-auth")
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === "logout") cache.setQueryData(userKey, null)
      else if (event.data === "login")
        void cache.resetQueries({ queryKey: userKey })
    }
    return () => channel.close()
  }, [cache])
  return query
}
export function useLogout() {
  const api = useAuthApi()
  const cache = useQueryClient()
  const router = useRouter()
  return async () => {
    await cache.cancelQueries()
    await api.logout()
    cache.clear()
    notifyAuthChange("logout")
    router.replace("/login")
    router.refresh()
  }
}
