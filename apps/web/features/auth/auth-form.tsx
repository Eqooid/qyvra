"use client"

import { Alert } from "@/components/ui/alert"
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel, FieldError } from "@/components/ui/field"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { ApiError } from "@/lib/api/client"
import { notifyAuthChange, useAuthApi, userKey } from "./provider"
import { LogIn } from "lucide-react"

const schema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(320),
  password: z.string().min(1, "Enter your password."),
})
type Values = z.infer<typeof schema>
export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const registerMode = mode === "register"
  const api = useAuthApi()
  const router = useRouter()
  const cache = useQueryClient()
  const [error, setError] = useState<string>()
  const [created, setCreated] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  })
  async function submit(values: Values) {
    setError(undefined)
    try {
      if (registerMode) {
        await api.register(values.email, values.password)
        setCreated(true)
      } else {
        await cache.cancelQueries({ queryKey: userKey })
        await api.login(values.email, values.password)
        cache.clear()
        notifyAuthChange()
        router.replace("/dashboard")
      }
    } catch (reason) {
      setError(
        reason instanceof ApiError
          ? reason.status === 401
            ? "Email or password is incorrect. Please try again."
            : reason.status === 409
              ? "Unable to create an account with those details. Try logging in instead."
              : reason.status === 400
                ? "Check your email and password. Registration passwords must meet the server's password policy."
                : reason.message
          : "Something went wrong. Please try again."
      )
    } finally {
      resetField("password")
    }
  }
  if (created)
    return (
      <div role="status">
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl font-semibold tracking-tight">
              Your account is ready
            </h1>
          </CardTitle>
          <CardDescription>Log in to open your workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link className="text-primary underline" href="/login">
            Continue to login
          </Link>
        </CardContent>
      </div>
    )
  return (
    <>
      <CardHeader>
        <p className="text-sm font-medium text-primary">
          Your personal workspace
        </p>
        <CardTitle>
          <h1 className="text-3xl font-semibold tracking-tight">
            {registerMode ? "Create an account" : "Welcome back"}
          </h1>
        </CardTitle>
        <CardDescription>
          {registerMode
            ? "A place to keep your important things together."
            : "Log in to QYVRA."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit(submit)}
          noValidate
          className="space-y-4"
          aria-busy={isSubmitting}
        >
          <Field>
            <FieldLabel htmlFor="email">Email address</FieldLabel>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              autoCapitalize="none"
              {...register("email")}
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "email-error" : undefined}
              disabled={isSubmitting}
            />
            {errors.email && (
              <FieldError id="email-error" className="text-sm text-destructive">
                {errors.email.message}
              </FieldError>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete={
                  registerMode ? "new-password" : "current-password"
                }
                {...register("password")}
                aria-invalid={!!errors.password}
                aria-describedby={
                  errors.password
                    ? "password-error"
                    : registerMode
                      ? "password-hint"
                      : undefined
                }
                disabled={isSubmitting}
                className="pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-0 right-0"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-controls="password"
                disabled={isSubmitting}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              </Button>
            </div>
            {registerMode && (
              <p id="password-hint" className="text-xs text-muted-foreground">
                Use a long, unique passphrase. The default policy allows 15–128
                characters; your server may require a different length.
              </p>
            )}
            {errors.password && (
              <FieldError id="password-error">
                {errors.password.message}
              </FieldError>
            )}
          </Field>
          {error && (
            <Alert
              variant="destructive"
              role="alert"
              className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
            >
              {error}
            </Alert>
          )}
          <Button type="submit" disabled={isSubmitting} className="mt-3 w-full">
            <LogIn />
            {isSubmitting
              ? "Please wait…"
              : registerMode
                ? "Create account"
                : "Log in"}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="border-0 bg-transparent pt-0 text-sm text-muted-foreground">
        {registerMode ? "Already have an account? " : "New here? "}
        <Link
          href={registerMode ? "/login" : "/register"}
          className="ml-1 font-medium text-primary underline underline-offset-4"
        >
          {registerMode ? "Log in" : "Create an account"}
        </Link>
      </CardFooter>
    </>
  )
}
