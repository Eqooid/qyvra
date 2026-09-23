"use client"

import { Monitor, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label="Change theme"
            title="Change theme"
          />
        }
      >
        <Sun className="dark:hidden" aria-hidden />
        <Moon className="hidden dark:block" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuRadioGroup
          aria-label="Theme"
          value={theme}
          onValueChange={(value: unknown) => {
            if (value === "light" || value === "dark" || value === "system") {
              setTheme(value)
            }
          }}
        >
          <DropdownMenuRadioItem
            closeOnClick
            value="light"
            className="min-h-10"
          >
            <Sun aria-hidden /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem closeOnClick value="dark" className="min-h-10">
            <Moon aria-hidden /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            closeOnClick
            value="system"
            className="min-h-10"
          >
            <Monitor aria-hidden /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
