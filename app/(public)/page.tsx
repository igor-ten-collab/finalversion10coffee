import type { Metadata } from "next"
import LenisProvider from "@/components/landing/LenisProvider"
import GSAPRegistry from "@/components/landing/GSAPRegistry"
import LandingPage from "@/components/landing/LandingPage"

export const metadata: Metadata = {
  description:
    "Оптовая платформа и интернет-магазин свежеобжаренного кофе, чая и аксессуаров из Сочи. Обжарка под заказ, доставка по всей России.",
  alternates: { canonical: "https://10coffee.ru/" },
}

export default function Page() {
  return (
    <LenisProvider>
      <GSAPRegistry />
      <LandingPage />
    </LenisProvider>
  )
}
