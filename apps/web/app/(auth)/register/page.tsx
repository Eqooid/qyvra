import { AuthForm } from "@/features/auth/auth-form"
export const metadata = { title: "Create account | Brainless" }
export default function RegisterPage() {
  return <AuthForm mode="register" />
}
