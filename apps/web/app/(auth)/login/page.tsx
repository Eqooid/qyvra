import { AuthForm } from "@/features/auth/auth-form"
export const metadata = { title: "Log in | QYVRA" }
export default function LoginPage() {
  return <AuthForm mode="login" />
}
