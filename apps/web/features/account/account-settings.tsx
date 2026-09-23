"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useQueryClient } from "@tanstack/react-query"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardDescription,
} from "@/components/ui/card"
import { Field, FieldLabel, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ConfirmationDialog } from "@/components/shared/confirmation-dialog"
import {
  notifyAuthChange,
  useAuthApi,
  useCurrentUser,
  userKey,
} from "@/features/auth/provider"
import { ApiError, type Profile } from "@/lib/api/client"
import { logoutAll, updateProfile } from "@/lib/api/account"
import { passwordFormSchema, profileFormSchema } from "./validation"

export function AccountSettings() {
  const user = useCurrentUser()
  return user.data ? (
    <SettingsForms key={user.data.id} profile={user.data} />
  ) : null
}

function SettingsForms({ profile }: { profile: Profile }) {
  const api = useAuthApi(),
    cache = useQueryClient(),
    router = useRouter()
  const profileBusy = useRef(false),
    passwordBusy = useRef(false)
  const [profileMessage, setProfileMessage] = useState<string>()
  const [passwordMessage, setPasswordMessage] = useState<string>()
  const profileForm = useForm<z.infer<typeof profileFormSchema>>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: {
      displayName: profile.displayName ?? "",
      timezone: profile.timezone,
      locale: profile.locale,
    },
  })
  const passwordForm = useForm<z.infer<typeof passwordFormSchema>>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmation: "" },
  })
  async function checkSession(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      const user = await api.currentUser()
      if (!user) {
        await cache.cancelQueries()
        cache.setQueryData(userKey, null)
        cache.removeQueries({
          predicate: (query) => query.queryKey[0] !== userKey[0],
        })
        notifyAuthChange("logout")
        router.replace("/login")
      }
    }
  }
  async function saveProfile(values: z.infer<typeof profileFormSchema>) {
    if (profileBusy.current) return
    profileBusy.current = true
    setProfileMessage(undefined)
    try {
      const updated = await updateProfile(api, values)
      await cache.cancelQueries({ queryKey: userKey })
      cache.setQueryData(userKey, updated)
      profileForm.reset(values)
      setProfileMessage("Profile saved.")
    } catch (error) {
      profileForm.setError("root", {
        message:
          error instanceof ApiError && error.status === 400
            ? "Check your display name, timezone and locale. The server did not accept these values."
            : error instanceof ApiError
              ? error.message
              : "Unable to save your profile.",
      })
      await checkSession(error).catch(() =>
        profileForm.setError("root", {
          message: "Unable to confirm your session. Please try again.",
        })
      )
    } finally {
      profileBusy.current = false
    }
  }
  async function savePassword(values: z.infer<typeof passwordFormSchema>) {
    if (passwordBusy.current) return
    passwordBusy.current = true
    setPasswordMessage(undefined)
    try {
      await api.changePassword(values.currentPassword, values.newPassword)
      passwordForm.reset()
      setPasswordMessage(
        "Password changed. Your other sessions have been logged out; this session remains active."
      )
    } catch (error) {
      passwordForm.setError(
        error instanceof ApiError && error.status === 401
          ? "currentPassword"
          : "root",
        {
          message:
            error instanceof ApiError && error.status === 401
              ? "Unable to verify your current password."
              : error instanceof ApiError && error.status === 400
                ? "The new password does not meet the server's password policy. Use a longer, strong passphrase."
                : error instanceof ApiError
                  ? error.message
                  : "Unable to change your password.",
        }
      )
      await checkSession(error).catch(() =>
        passwordForm.setError("root", {
          message: "Unable to confirm your session. Please try again.",
        })
      )
    } finally {
      passwordBusy.current = false
    }
  }
  async function leaveAll() {
    try {
      await logoutAll(api)
    } catch (error) {
      await checkSession(error)
      throw error
    }
    await cache.cancelQueries()
    cache.setQueryData(userKey, null)
    cache.removeQueries({
      predicate: (query) => query.queryKey[0] !== userKey[0],
    })
    notifyAuthChange("logout")
    router.replace("/login")
    router.refresh()
  }
  return (
    <section className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Account settings
        </h1>
        <p className="mt-2 text-muted-foreground">
          Manage your profile and account security.
        </p>
      </div>
      <Card>
        <CardHeader>
          <h2 className="text-xl font-semibold">Profile</h2>
          <CardDescription className="break-all">
            {profile.email}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            onSubmit={(event) =>
              void profileForm.handleSubmit(saveProfile)(event)
            }
            className="space-y-4"
            aria-busy={profileForm.formState.isSubmitting}
          >
            {(
              [
                ["displayName", "Display name"],
                ["timezone", "Timezone"],
                ["locale", "Locale"],
              ] as const
            ).map(([name, label]) => (
              <Field key={name}>
                <FieldLabel htmlFor={name}>{label}</FieldLabel>
                <Input
                  id={name}
                  {...profileForm.register(name)}
                  disabled={profileForm.formState.isSubmitting}
                  aria-invalid={!!profileForm.formState.errors[name]}
                  aria-describedby={`${name}-error`}
                />
                <FieldError id={`${name}-error`}>
                  {profileForm.formState.errors[name]?.message}
                </FieldError>
              </Field>
            ))}
            {profileForm.formState.errors.root && (
              <Alert variant="destructive" role="alert">
                {profileForm.formState.errors.root.message}
              </Alert>
            )}
            {profileMessage && <p role="status">{profileMessage}</p>}
            <Button
              type="submit"
              disabled={
                profileForm.formState.isSubmitting ||
                !profileForm.formState.isDirty
              }
            >
              {profileForm.formState.isSubmitting ? "Saving…" : "Save profile"}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 className="text-xl font-semibold">Change password</h2>
          <CardDescription>
            Use a strong passphrase. Changing your password signs out your other
            sessions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            onSubmit={(event) =>
              void passwordForm.handleSubmit(savePassword)(event)
            }
            className="space-y-4"
            aria-busy={passwordForm.formState.isSubmitting}
          >
            {(
              [
                ["currentPassword", "Current password"],
                ["newPassword", "New password"],
                ["confirmation", "Confirm new password"],
              ] as const
            ).map(([name, label]) => (
              <Field key={name}>
                <FieldLabel htmlFor={name}>{label}</FieldLabel>
                <Input
                  id={name}
                  type="password"
                  autoComplete={
                    name === "currentPassword"
                      ? "current-password"
                      : "new-password"
                  }
                  {...passwordForm.register(name)}
                  disabled={passwordForm.formState.isSubmitting}
                  aria-invalid={!!passwordForm.formState.errors[name]}
                  aria-describedby={`${name}-error`}
                />
                <FieldError id={`${name}-error`}>
                  {passwordForm.formState.errors[name]?.message}
                </FieldError>
              </Field>
            ))}
            {passwordForm.formState.errors.root && (
              <Alert variant="destructive" role="alert">
                {passwordForm.formState.errors.root.message}
              </Alert>
            )}
            {passwordMessage && <p role="status">{passwordMessage}</p>}
            <Button
              type="submit"
              disabled={passwordForm.formState.isSubmitting}
            >
              {passwordForm.formState.isSubmitting
                ? "Changing password…"
                : "Change password"}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 className="text-xl font-semibold">Sessions</h2>
          <CardDescription>
            Log out on every browser and device, including this one. You will
            need to log in again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ConfirmationDialog
            action="Log out of all sessions"
            title="Log out everywhere?"
            description="All your sessions will be revoked, including this browser. Your documents and profile will be preserved."
            destructive
            confirm={leaveAll}
          />
        </CardContent>
      </Card>
    </section>
  )
}
