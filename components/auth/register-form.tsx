"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { signUp } from "@/lib/actions/auth"
import { registerSchema, type RegisterFormData } from "@/lib/utils/validators"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import PhoneInput from "@/components/shared/phone-input"
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form"
import { Loader2, CheckCircle2 } from "lucide-react"
import { SocialAuthButtons } from "./social-auth-buttons"

interface RegisterFormProps {
  onSwitchToLogin: () => void
  onAuthenticated: () => void
  customerType?: "individual" | "business"
}

export function RegisterForm({ onSwitchToLogin, onAuthenticated, customerType }: RegisterFormProps) {
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [agreed, setAgreed] = useState(false)

  const form = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: "", full_name: "", phone: "" },
  })

  async function onSubmit(data: RegisterFormData) {
    setError(null)
    setSuccess(null)
    setLoading(true)
    try {
      const result = await signUp({
        ...data,
        customer_type: customerType ?? "business",
      })
      if (result?.error) setError(result.error)
      else if (result?.success && result.redirectTo) {
        onAuthenticated()
        window.location.assign(result.redirectTo)
      }
      else if (result?.success) {
        setSuccess(result.message || "Регистрация успешна!")
        if (result.password) setGeneratedPassword(result.password)
      }
    } catch {
      setError("Произошла ошибка при регистрации")
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="space-y-5 text-center py-4">
        <CheckCircle2 className="h-14 w-14 text-green-600 mx-auto" />
        <h2 className="text-[18px] font-black text-neutral-900">Регистрация завершена!</h2>
        <p className="text-[12px] text-neutral-500 max-w-sm mx-auto leading-relaxed">{success}</p>
        {generatedPassword && (
          <div className="rounded-xl bg-neutral-50 border border-neutral-200 p-4 text-left space-y-2">
            <p className="text-[11px] text-neutral-400 font-medium">Ваш пароль для входа:</p>
            <p className="text-[18px] font-mono font-bold text-neutral-900 tracking-wider select-all">
              {generatedPassword}
            </p>
            <p className="text-[11px] text-neutral-400">Сохраните его в надёжном месте</p>
          </div>
        )}
        <Button onClick={onSwitchToLogin} className="rounded-xl font-bold">
          Перейти к входу
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[20px] font-black text-neutral-900 tracking-tight">Регистрация</h2>
        <p className="text-[12px] text-neutral-400 mt-1">
          Пароль будет сгенерирован автоматически
        </p>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-[12px] text-red-600 font-medium">
          {error}
        </div>
      )}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField control={form.control} name="full_name" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[12px] font-semibold text-neutral-600">ФИО</FormLabel>
              <FormControl>
                <Input placeholder="Иванов Иван Иванович" className="h-11 rounded-xl" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="email" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[12px] font-semibold text-neutral-600">Email</FormLabel>
              <FormControl>
                <Input type="email" placeholder="your@email.com" autoComplete="email" className="h-11 rounded-xl" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="phone" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[12px] font-semibold text-neutral-600">Телефон</FormLabel>
              <FormControl>
                <PhoneInput
                  className="flex h-11 w-full rounded-xl border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
                  value={field.value}
                  onChange={field.onChange}
                  required
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              name="consent"
              required
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 accent-[#5b328a] w-4 h-4 shrink-0"
            />
            <span className="text-xs text-muted-foreground leading-relaxed">
              Принимаю{" "}
              <a href="/Политика конфиденциальности.pdf" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground transition-colors">
                политику конфиденциальности
              </a>{" "}
              и{" "}
              <a href="/Политика обработки персональных данных пользователей сайта.pdf" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground transition-colors">
                правила обработки персональных данных
              </a>
            </span>
          </label>

          <Button type="submit" className="w-full h-11 rounded-xl font-bold" disabled={loading || !agreed}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Зарегистрироваться
          </Button>
        </form>
      </Form>

      {customerType === "individual" && <SocialAuthButtons disabled={!agreed} />}

      <p className="text-center text-[12px] text-neutral-400">
        Уже есть аккаунт?{" "}
        <button
          type="button"
          onClick={onSwitchToLogin}
          className="text-[#5b328a] font-semibold hover:text-[#4a2870] transition-colors"
        >
          Войти
        </button>
      </p>
    </div>
  )
}
