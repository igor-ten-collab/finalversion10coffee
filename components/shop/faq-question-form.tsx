"use client"

import { FormEvent, useState } from "react"
import { ArrowRight, LoaderCircle } from "lucide-react"
import { toast } from "sonner"

export function FaqQuestionForm() {
  const [isOpen, setIsOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    setIsSubmitting(true)
    setError(null)
    setMessage(null)

    const form = new FormData(formElement)
    const response = await fetch("/api/faq", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: form.get("question"),
        name: form.get("name"),
        email: form.get("email"),
        consent: form.get("consent") === "on",
      }),
    }).catch(() => null)

    const result = response ? await response.json().catch(() => ({})) : {}
    setIsSubmitting(false)
    if (!response?.ok) {
      const errorMessage = typeof result.error === "string" ? result.error : "Не удалось отправить вопрос. Попробуйте ещё раз."
      setError(errorMessage)
      toast.error(errorMessage)
      return
    }

    formElement.reset()
    const successMessage = "Вопрос отправлен. После модерации мы добавим ответ в FAQ."
    setMessage(successMessage)
    toast.success(successMessage)
  }

  return (
    <div className="mt-7">
      <button type="button" onClick={() => { setIsOpen((value) => !value); setError(null); setMessage(null) }} className="inline-flex items-center gap-2 text-sm font-black text-[#5b328a]">
        Задать вопрос <ArrowRight className={`h-4 w-4 transition ${isOpen ? "rotate-90" : ""}`} />
      </button>
      {isOpen && (
        <form onSubmit={onSubmit} className="mt-5 grid gap-3 rounded-2xl border border-black/[0.09] bg-white p-4 shadow-sm">
          <textarea name="question" required minLength={10} maxLength={1000} rows={4} placeholder="Напишите ваш вопрос" className="w-full resize-y rounded-xl border border-black/[0.12] bg-[#f8f5f1] px-3 py-2.5 text-sm outline-none transition focus:border-[#5b328a]" />
          <div className="grid gap-3 sm:grid-cols-2">
            <input name="name" required minLength={2} maxLength={120} placeholder="Имя (обязательно)" className="min-w-0 rounded-xl border border-black/[0.12] bg-[#f8f5f1] px-3 py-2.5 text-sm outline-none transition focus:border-[#5b328a]" />
            <input name="email" type="email" required maxLength={254} placeholder="Email для ответа (обязательно)" className="min-w-0 rounded-xl border border-black/[0.12] bg-[#f8f5f1] px-3 py-2.5 text-sm outline-none transition focus:border-[#5b328a]" />
          </div>
          <label className="flex cursor-pointer items-start gap-2 rounded-xl bg-[#f8f5f1] p-3">
            <input name="consent" type="checkbox" required className="mt-0.5 h-4 w-4 shrink-0 accent-[#5b328a]" />
            <span className="text-xs leading-5 text-[#6e655e]">Я принимаю <a href="/Политика конфиденциальности.pdf" target="_blank" rel="noopener noreferrer" className="font-bold text-[#5b328a] underline">политику конфиденциальности</a> и даю согласие на обработку персональных данных в соответствии с <a href="/Политика обработки персональных данных пользователей сайта.pdf" target="_blank" rel="noopener noreferrer" className="font-bold text-[#5b328a] underline">правилами обработки персональных данных</a>.</span>
          </label>
          <button disabled={isSubmitting} className="inline-flex w-fit items-center gap-2 rounded-xl bg-[#5b328a] px-4 py-2.5 text-sm font-black text-white disabled:cursor-wait disabled:opacity-60">
            {isSubmitting && <LoaderCircle className="h-4 w-4 animate-spin" />}
            Отправить вопрос
          </button>
          {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
          {message && <p role="status" className="text-sm font-medium text-emerald-700">{message}</p>}
        </form>
      )}
    </div>
  )
}
