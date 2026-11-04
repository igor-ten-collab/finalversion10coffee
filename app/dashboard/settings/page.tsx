"use client"

import { useState, useEffect, useRef } from "react"
import { useSearchParams } from "next/navigation"
import { useAuth } from "@/providers/auth-provider"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import PhoneInput from "@/components/shared/phone-input"
import AddressInput from "@/components/shared/address-input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Plus, X, Loader2, Camera, KeyRound, Check, Send } from "lucide-react"
import { toast } from "sonner"
import { saveQuickComments, getQuickComments } from "@/lib/actions/client-settings"
import { isValidRussianPhone, normalizeRussianPhone } from "@/lib/utils/phone"

function resizeImage(file: File, maxSize: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement("canvas")
      canvas.width = maxSize
      canvas.height = maxSize
      const ctx = canvas.getContext("2d")!
      const min = Math.min(img.width, img.height)
      const sx = (img.width - min) / 2
      const sy = (img.height - min) / 2
      ctx.drawImage(img, sx, sy, min, min, 0, 0, maxSize, maxSize)
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Canvas toBlob failed"))),
        "image/jpeg",
        0.85
      )
    }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}

export default function SettingsPage() {
  const { user } = useAuth()
  const searchParams = useSearchParams()
  const supabase = createClient()
  const isIndividual = user?.user_metadata?.customer_type === "individual"
  const [loading, setLoading] = useState(false)
  const [avatarLoading, setAvatarLoading] = useState(false)
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [address, setAddress] = useState("")
  const [addressComplete, setAddressComplete] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [quickComments, setQuickComments] = useState<string[]>([])
  const [newComment, setNewComment] = useState("")
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [socialProviders, setSocialProviders] = useState<string[]>([])
  const [socialLoading, setSocialLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const socialError = searchParams.get("social_error")
  const linkedProvider = searchParams.get("social_linked")
  const transferProvider = searchParams.get("social_transfer")

  useEffect(() => {
    if (user) {
      setFullName(user.user_metadata?.full_name || "")
      setEmail(user.email || "")
      setPhone(user.user_metadata?.phone || "")
      setAddress((user.user_metadata?.address as string) || "")
      setAvatarUrl(user.user_metadata?.avatar_url || null)

      // Load settings via server action (bypasses RLS)
      getQuickComments().then((comments) => {
        setQuickComments(comments)
      })

      fetch("/api/auth/social/identities", { cache: "no-store" })
        .then(async (response) => response.ok ? response.json() : { providers: [] })
        .then((data: { providers?: unknown }) => {
          setSocialProviders(Array.isArray(data.providers) ? data.providers.filter((provider): provider is string => typeof provider === "string") : [])
        })
        .catch(() => setSocialProviders([]))
    }
  }, [user, supabase])

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !user) return
    setAvatarLoading(true)

    try {
      const resized = await resizeImage(file, 200)
      const form = new FormData()
      form.append("file", resized, "avatar.jpg")

      const res = await fetch("/api/upload-avatar", { method: "POST", body: form })
      const json = await res.json().catch(() => null)

      if (!res.ok) throw new Error(json?.error || `Ошибка загрузки аватара (${res.status})`)
      if (!json?.url) throw new Error("Сервер не вернул ссылку на аватар")

      const { error: profileError } = await supabase.auth.updateUser({ data: { avatar_url: json.url } })
      if (profileError) throw new Error("Не удалось сохранить аватар в профиле")
      setAvatarUrl(json.url)
      toast.success("Аватар обновлён")
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Ошибка загрузки"
      toast.error(message)
    } finally {
      setAvatarLoading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function handleSaveProfile() {
    if (!user) return

    if (!isValidRussianPhone(phone)) {
      toast.error("Введите корректный мобильный телефон")
      return
    }
    if (isIndividual && address.trim() && !addressComplete) {
      toast.error("Выберите адрес из подсказок с улицей и номером дома")
      return
    }

    setLoading(true)

    try {
      const normalizedPhone = normalizeRussianPhone(phone)
      // Update auth metadata so values persist across sessions
      const { error: authError } = await supabase.auth.updateUser({
        email,
        data: { full_name: fullName, phone: normalizedPhone, address: address.trim() },
      })
      if (authError) throw authError

      setPhone(normalizedPhone)
      toast.success("Профиль обновлён")
    } catch {
      toast.error("Ошибка при сохранении")
    }
    setLoading(false)
  }

  async function handleAddComment() {
    if (!newComment.trim() || !user) return

    const updated = [...quickComments, newComment.trim()]
    setQuickComments(updated)
    setNewComment("")

    const result = await saveQuickComments(updated)
    if (!result.success) {
      toast.error("Ошибка сохранения комментария")
      setQuickComments(quickComments) // revert
    }
  }

  function handleLinkProvider(provider: "yandex" | "vk" | "telegram", transfer = false) {
    if (!user || socialLoading) return
    setSocialLoading(true)
    const transferQuery = transfer ? "&transfer=1" : ""
    window.location.assign(`/api/auth/social/${provider}?intent=link&customer_type=${isIndividual ? "individual" : "business"}${transferQuery}`)
  }

  async function handleChangePassword() {
    if (!user) return
    if (newPassword.length < 8 || newPassword.length > 72) {
      toast.error("Пароль должен содержать от 8 до 72 символов")
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error("Пароли не совпадают")
      return
    }

    setPasswordLoading(true)
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword, currentPassword })
      if (error) throw error
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      toast.success("Пароль изменён")
    } catch (error) {
      const message = error && typeof error === "object" && "message" in error
        ? String(error.message)
        : "Не удалось изменить пароль"
      toast.error(message)
    } finally {
      setPasswordLoading(false)
    }
  }

  async function handleRemoveComment(index: number) {
    if (!user) return

    const updated = quickComments.filter((_, i) => i !== index)
    setQuickComments(updated)

    const result = await saveQuickComments(updated)
    if (!result.success) {
      toast.error("Ошибка сохранения")
      setQuickComments(quickComments) // revert
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Настройки</h1>
        <p className="text-muted-foreground">
          Управление профилем и настройками
        </p>
      </div>

      {socialError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Не удалось привязать способ входа: {socialError}
        </div>
      )}

      {transferProvider && (transferProvider === "yandex" || transferProvider === "vk" || transferProvider === "telegram") && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>
            Этот способ входа уже связан с другой учётной записью. Можно перенести только способ входа в текущий аккаунт.
            Заказы, баллы и другие данные двух аккаунтов при этом не объединяются.
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-3"
            disabled={socialLoading}
            onClick={() => handleLinkProvider(transferProvider, true)}
          >
            Подтвердить перенос
          </Button>
        </div>
      )}

      {linkedProvider && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Способ входа «{linkedProvider === "yandex" ? "Яндекс" : linkedProvider === "vk" ? "VK" : linkedProvider === "telegram" ? "Telegram" : linkedProvider}» привязан к аккаунту.
        </div>
      )}

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Профиль</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="relative h-16 w-16 rounded-full bg-[#e6610d] flex items-center justify-center text-white text-lg font-bold overflow-hidden group shrink-0"
              disabled={avatarLoading}
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt="Аватар" className="h-full w-full object-cover" />
              ) : (
                (fullName || user?.email || "U").charAt(0).toUpperCase()
              )}
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                {avatarLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-white" />
                ) : (
                  <Camera className="h-5 w-5 text-white" />
                )}
              </div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleAvatarUpload}
            />
            <div>
              <p className="text-sm font-medium">Фото профиля</p>
              <p className="text-xs text-muted-foreground">Нажмите для загрузки</p>
            </div>
          </div>

          <Separator />

          <div>
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              readOnly
              autoComplete="email"
              title="Изменение email требует подтверждения нового адреса и пока недоступно"
              className="mt-1.5"
            />
            {user?.user_metadata?.email_is_placeholder === true && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Email для заказа можно указать при оформлении. Изменение адреса аккаунта пока недоступно.
              </p>
            )}
          </div>
          <div>
            <Label>ФИО</Label>
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label>Телефон</Label>
            <PhoneInput
              value={phone}
              onChange={setPhone}
              required
              className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
            />
          </div>
          {isIndividual && (
            <div>
              <Label>Адрес доставки</Label>
              <AddressInput
                value={address}
                onChange={setAddress}
                onCompleteChange={setAddressComplete}
                requireHouse
                placeholder="Город, улица, дом, квартира"
                className="mt-1.5"
              />
            </div>
          )}
          <Button onClick={handleSaveProfile} disabled={loading || (isIndividual && Boolean(address.trim()) && !addressComplete)}>
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Сохранить
          </Button>
        </CardContent>
      </Card>

      {isIndividual && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Способы входа</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Привяжите удобные социальные сети к текущему аккаунту. Все способы будут вести в один личный кабинет.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              {([
                { id: "yandex", label: "Яндекс", className: "bg-[#FC3F1D]" },
                { id: "vk", label: "VK", className: "bg-[#0077FF]" },
                { id: "telegram", label: "Telegram", className: "bg-[#2AABEE]" },
              ] as const).map((provider) => {
                const linked = socialProviders.includes(provider.id)
                return (
                  <div key={provider.id} className="rounded-xl border border-neutral-200 p-3">
                    <div className="flex items-center gap-2">
                      <span className={`flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold text-white ${provider.className}`}>
                        {provider.id === "telegram" ? <Send className="h-3.5 w-3.5" fill="currentColor" /> : provider.label === "Яндекс" ? "Я" : "VK"}
                      </span>
                      <span className="text-sm font-semibold">{provider.label}</span>
                    </div>
                    {linked ? (
                      <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                        <Check className="h-3.5 w-3.5" /> Привязан
                      </p>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3 w-full"
                        disabled={socialLoading}
                        onClick={() => handleLinkProvider(provider.id)}
                      >
                        Привязать
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {isIndividual && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-[#5b328a]" />
              Смена пароля
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Новый пароль должен содержать от 8 до 72 символов.
            </p>
            <div>
              <Label htmlFor="current-password">Текущий пароль</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="new-password">Новый пароль</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="confirm-password">Повторите новый пароль</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void handleChangePassword()}
                className="mt-1.5"
              />
            </div>
            <Button
              type="button"
              onClick={handleChangePassword}
              disabled={passwordLoading || !currentPassword || !newPassword || !confirmPassword}
            >
              {passwordLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Изменить пароль
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Quick comments */}
      {!isIndividual && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Быстрые комментарии</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Сохранённые комментарии для быстрого выбора при оформлении заказа
            </p>

            {quickComments.length > 0 && (
              <div className="space-y-2">
                {quickComments.map((comment, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 p-2 bg-muted rounded-md"
                  >
                    <span className="text-sm flex-1">{comment}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemoveComment(index)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Input
                placeholder="Новый комментарий"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddComment()}
              />
              <Button variant="outline" onClick={handleAddComment}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
