import { Card } from "@/components/ui/card"
import Link from "next/link"
import { Files } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"
import { AnimatedLoginBackground } from "@/components/auth/animated-login-background"
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <main className="relative isolate flex min-h-svh flex-col overflow-hidden bg-muted/30">
      <AnimatedLoginBackground />
      <header className="relative z-10 flex items-center justify-between gap-4 px-6 py-5 sm:px-10">
        <Link
          href="/"
          className="flex items-center gap-3 rounded-lg text-lg font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Files className="text-primary" aria-hidden />
          Brainless
        </Link>
        <ThemeToggle />
      </header>
      <div className="relative z-10 flex flex-1 items-center justify-center px-4 py-8 sm:py-12">
        <Card className="w-full max-w-sm shadow-sm">{children}</Card>
      </div>
      <p className="relative z-10 px-6 pb-6 text-center text-xs text-muted-foreground">
        Your documents. A little more organized.
      </p>
    </main>
  )
}
