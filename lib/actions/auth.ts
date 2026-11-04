"use server"

import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import crypto from "crypto"
import { createSmtpTransport } from "@/lib/email/smtp"
import { dbQuery } from "@/lib/db"
import { isValidRussianPhone, normalizeRussianPhone } from "@/lib/utils/phone"

const transporter = createSmtpTransport()

function generatePassword(length = 12): string {
  // Ambiguous characters (0/O, 1/l/I) are excluded so a password sent by
  // email is not mistyped into a "wrong password" login failure.
  const chars =
    "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%"
  return Array.from(crypto.randomBytes(length))
    .map((byte) => chars[byte % chars.length])
    .join("")
}

export async function signIn(formData: {
  email: string
  password: string
}, expectedCustomerType?: "individual" | "business") {
  const supabase = await createClient(expectedCustomerType)

  const { data, error } = await supabase.auth.signInWithPassword({
    email: formData.email.trim().toLowerCase(),
    password: formData.password,
  })

  if (error) {
    return { error: error.message }
  }

  // Check that this is a client user
  const userType = data.user?.user_metadata?.user_type
  if (userType !== "client") {
    await supabase.auth.signOut()
    return { error: "Этот аккаунт не является клиентским" }
  }

  // Accounts created before the retail cabinet did not have customer_type.
  // All such legacy accounts are wholesale accounts; only an explicit
  // "individual" value identifies a retail customer.
  const storedCustomerType = data.user?.user_metadata?.customer_type
  const actualCustomerType = storedCustomerType === "individual" ? "individual" : "business"

  if (expectedCustomerType && actualCustomerType !== expectedCustomerType) {
    await supabase.auth.signOut()
    return { error: expectedCustomerType === "individual" ? "Этот аккаунт относится к оптовому кабинету" : "Этот аккаунт относится к кабинету покупателя" }
  }

  // Repair legacy metadata after a successful wholesale login so all pages
  // see the same account type during this and subsequent sessions.
  if (storedCustomerType !== actualCustomerType) {
    await supabase.auth.updateUser({ data: { customer_type: actualCustomerType } })
  }

  revalidatePath("/", "layout")
  return {
    success: true,
    redirectTo: expectedCustomerType === "individual" ? process.env.SHOP_SITE_URL || "/main" : "/dashboard",
  }
}

export async function signUp(formData: {
  email: string
  full_name: string
  phone: string
  address?: string
  customer_type?: "individual" | "business"
}) {
  const adminClient = createAdminClient()
  const phone = normalizeRussianPhone(formData.phone)

  if (!isValidRussianPhone(phone)) {
    return { error: "Введите корректный мобильный телефон" }
  }

  // Generate password automatically
  const password = generatePassword()

  const { data, error } = await adminClient.auth.admin.createUser({
    email: formData.email,
    password: password,
    email_confirm: true,
    user_metadata: {
      user_type: "client",
      full_name: formData.full_name,
      phone,
      address: formData.address || "",
      customer_type: formData.customer_type || "business",
    },
  })

  if (error) {
    if (error.message.includes("already")) {
      return { error: "Пользователь с таким email уже зарегистрирован" }
    }
    return { error: error.message }
  }

  if (data.user?.id) {
    await dbQuery(
      `insert into public.client_profiles (id, email, full_name, phone, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())
       on conflict (id) do update
          set email = excluded.email,
              full_name = excluded.full_name,
              phone = excluded.phone,
              updated_at = now()`,
      [data.user.id, formData.email, formData.full_name, phone]
    )
  }

  // Sync to Payload CMS clients collection
  try {
    const { getPayload } = await import("payload")
    const payloadConfig = await import("@payload-config")
    const payload = await getPayload({ config: payloadConfig.default })

    await payload.create({
      collection: "clients",
      data: {
        fullName: formData.full_name,
        email: formData.email,
        phone,
        supabaseId: data.user?.id || "",
        address: formData.address || "",
        customerType: formData.customer_type || "business",
        salesChannel: formData.customer_type === "individual" ? "retail" : "wholesale",
      },
    })
  } catch (syncError) {
    console.error("Failed to sync client to Payload:", syncError)
  }

  // Send password to email so the customer keeps a record of the credentials.
  const customerType = formData.customer_type || "business"
  const email = formData.email.trim().toLowerCase()
  const loginUrl = customerType === "individual"
    ? "shop.10coffee.ru"
    : "10coffee.ru"
  try {
    await transporter.sendMail({
      from: `"10coffee" <${process.env.SMTP_EMAIL}>`,
      to: email,
      subject: "Ваш логин и пароль для входа в личный кабинет 10coffee",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h2 style="margin:0 0 16px">Добро пожаловать в 10coffee!</h2>
          <p style="color:#666;margin:0 0 24px">Вы успешно зарегистрированы. Сохраните эти данные — они нужны для каждого входа в личный кабинет.</p>
          <div style="background:#f5f5f5;border-radius:12px;padding:20px;margin:0 0 24px">
            <p style="margin:0 0 8px;color:#999;font-size:13px">Логин (email)</p>
            <p style="margin:0 0 16px;font-weight:bold">${email}</p>
            <p style="margin:0 0 8px;color:#999;font-size:13px">Пароль</p>
            <p style="margin:0;font-weight:bold;font-size:18px;letter-spacing:1px">${password}</p>
          </div>
          <p style="margin:0 0 8px;font-size:13px;color:#666">Вход для ${customerType === "individual" ? "покупателей" : "оптовиков"}: <a href="https://${loginUrl}" style="color:#5b328a;font-weight:600">${loginUrl}</a></p>
          <p style="color:#999;font-size:12px;margin:0">Рекомендуем сохранить пароль в надёжном месте. Его можно сменить в настройках кабинета.</p>
        </div>
      `,
    })
  } catch (emailError) {
    console.error("Failed to send password email:", emailError)
    // The account already exists. Give its creator access even if SMTP is
    // unavailable, without claiming that an email was sent.
    return {
      success: true,
      message: "Аккаунт создан, но письмо отправить не удалось. Сохраните пароль ниже и используйте его для входа.",
      password,
      userId: data.user?.id,
    }
  }

  // A new customer should enter the same isolated account context immediately.
  // This also gives the registration flow the same completion behaviour as sign-in.
  const sessionClient = await createClient(customerType)
  const { error: sessionError } = await sessionClient.auth.signInWithPassword({
    email,
    password,
  })

  if (sessionError) {
    return {
      success: true,
      message: `Регистрация успешна! Пароль отправлен на ${email}. Проверьте почту.`,
      password,
      userId: data.user?.id,
    }
  }

  revalidatePath("/", "layout")
  return {
    success: true,
    redirectTo: customerType === "individual" ? process.env.SHOP_SITE_URL || "/main" : "/dashboard",
  }
}

export async function signOut(scope?: "individual" | "business") {
  const supabase = await createClient(scope)
  await supabase.auth.signOut()
  redirect(scope === "individual" ? "/shop" : "/")
}

export async function resetPassword(formData: { email: string; customerType?: "individual" | "business" }) {
  const email = formData.email.trim().toLowerCase()
  const adminClient = createAdminClient()

  const { data: users, error: listError } = await adminClient.auth.admin.listUsers()
  if (listError) return { error: "Ошибка при поиске пользователя" }

  const user = users.users.find(
    (u) => u.email?.toLowerCase() === email
  )

  if (!user) {
    return { error: "Пользователь с таким email не найден" }
  }

  // Accounts that predate the retail cabinet have no explicit customer_type
  // and are treated as wholesale accounts, exactly like signIn. Recovery must
  // not reset the password of an account that cannot log in to this site,
  // otherwise the customer receives a new password that the login rejects.
  if (formData.customerType) {
    const accountType = user.user_metadata?.customer_type === "individual" ? "individual" : "business"
    if (accountType !== formData.customerType) {
      return {
        error: formData.customerType === "individual"
          ? "Этот аккаунт относится к оптовому кабинету. Восстановите пароль на сайте 10coffee.ru."
          : "Этот аккаунт относится к кабинету покупателя. Восстановите пароль на сайте shop.10coffee.ru.",
      }
    }
  }

  const newPassword = generatePassword()

  // Do not invalidate the current password when SMTP cannot accept the email.
  // Only apply the generated password after the send operation succeeds.
  try {
    await transporter.sendMail({
      from: `"10coffee" <${process.env.SMTP_EMAIL}>`,
      to: email,
      subject: "Новый пароль для входа в личный кабинет 10coffee",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h2 style="margin:0 0 16px">Сброс пароля</h2>
          <p style="color:#666;margin:0 0 24px">Ваш пароль был сброшен. Используйте новый пароль для входа.</p>
          <div style="background:#f5f5f5;border-radius:12px;padding:20px;margin:0 0 24px">
            <p style="margin:0 0 8px;color:#999;font-size:13px">Email</p>
            <p style="margin:0 0 16px;font-weight:bold">${email}</p>
            <p style="margin:0 0 8px;color:#999;font-size:13px">Новый пароль</p>
            <p style="margin:0;font-weight:bold;font-size:18px;letter-spacing:1px">${newPassword}</p>
          </div>
          <p style="color:#999;font-size:12px;margin:0">Вы можете изменить пароль в настройках личного кабинета.</p>
        </div>
      `,
    })
  } catch (emailError) {
    console.error("Failed to send reset email:", emailError)
    return { error: "Не удалось отправить письмо. Пароль не изменён. Попробуйте позже." }
  }

  const { error } = await adminClient.auth.admin.updateUserById(user.id, {
    password: newPassword,
  })

  if (error) {
    return { error: "Не удалось изменить пароль. Повторите восстановление пароля." }
  }

  return { success: true, message: `Новый пароль отправлен на ${email}` }
}

// ============================================================
// Admin auth
// ============================================================

export async function adminSignIn(formData: {
  email: string
  password: string
}) {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.signInWithPassword({
    email: formData.email,
    password: formData.password,
  })

  if (error) {
    return { error: error.message }
  }

  const userType = data.user?.user_metadata?.user_type
  if (userType !== "admin") {
    await supabase.auth.signOut()
    return { error: "Этот аккаунт не является администраторским" }
  }

  revalidatePath("/", "layout")
  redirect("/admin")
}

export async function adminSignOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/admin/login")
}

export async function adminSignUpWithInvite(formData: {
  token: string
  password: string
  full_name: string
}) {
  const adminClient = createAdminClient()

  // Verify invite token
  const { data: invitation, error: inviteError } = await adminClient
    .from("admin_invitations")
    .select("*")
    .eq("token", formData.token)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .single()

  if (inviteError || !invitation) {
    return { error: "Приглашение недействительно или истекло" }
  }

  // Create admin user
  const { data, error } = await adminClient.auth.admin.createUser({
    email: invitation.email,
    password: formData.password,
    email_confirm: true,
    user_metadata: {
      user_type: "admin",
      full_name: formData.full_name,
      admin_role: invitation.role,
    },
  })

  if (error) {
    return { error: error.message }
  }

  // Mark invitation as used
  await adminClient
    .from("admin_invitations")
    .update({ used_at: new Date().toISOString() })
    .eq("id", invitation.id)

  // Update admin_profiles with invited_by
  if (data.user) {
    await adminClient
      .from("admin_profiles")
      .update({ invited_by: invitation.invited_by })
      .eq("id", data.user.id)
  }

  return { success: true, message: "Аккаунт администратора создан. Войдите с вашим паролем." }
}

export async function createAdminInvitation(formData: {
  email: string
  role: "ADMIN" | "MANAGER"
}) {
  const supabase = await createClient()

  // Verify current user is ADMIN
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: "Не авторизован" }

  const { data: adminProfile } = await supabase
    .from("admin_profiles")
    .select("role")
    .eq("id", user.id)
    .single()

  if (!adminProfile || adminProfile.role !== "ADMIN") {
    return { error: "Только администратор может создавать приглашения" }
  }

  // Generate invite token
  const token = crypto.randomBytes(32).toString("hex")
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 7) // 7 days

  const { error } = await supabase.from("admin_invitations").insert({
    email: formData.email,
    role: formData.role,
    invited_by: user.id,
    token,
    expires_at: expiresAt.toISOString(),
  })

  if (error) {
    return { error: error.message }
  }

  const inviteUrl = `${process.env.NEXT_PUBLIC_SITE_URL || ""}/admin/login?invite=${token}`

  return {
    success: true,
    message: `Приглашение создано. Ссылка: ${inviteUrl}`,
    inviteUrl,
  }
}

export async function getCurrentUser(scope?: "individual" | "business") {
  const supabase = await createClient(scope)
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

export async function getClientProfile() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  const { data: profile } = await supabase
    .from("client_profiles")
    .select("*")
    .eq("id", user.id)
    .single()

  return profile
}

export async function getAdminProfile() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  const { data: profile } = await supabase
    .from("admin_profiles")
    .select("*")
    .eq("id", user.id)
    .single()

  return profile
}
