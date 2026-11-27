import type { Metadata } from "next"
import { Mail, MapPin, MessageCircle, Phone, Send } from "lucide-react"
import { ShopHeader } from "@/components/shop/shop-header"
import { getCachedShopProducts, getProductTypes } from "@/lib/actions/products"

export const metadata: Metadata = {
  title: "Контакты — 10coffee",
  description: "Контакты интернет-магазина 10coffee: телефон, почта, мессенджеры и адрес в Сочи.",
}

export const dynamic = "force-dynamic"

const MAX_URL = "https://max.ru/u/f9LHodD0cOKa1C5S0VRomlqqlvMnh7CX7AaTfiG3sTv28xhc-4miAZFMuj4"

export default async function ShopContactsPage() {
  const [products, productTypes] = await Promise.all([getCachedShopProducts(), getProductTypes()])
  return <main className="min-h-screen bg-[#f8f5f1] text-[#1d1d1b]"><ShopHeader products={products} productTypes={productTypes} /><article className="mx-auto max-w-6xl px-5 py-16 lg:px-10 lg:py-24"><p className="text-xs font-black uppercase tracking-[0.22em] text-[#e6610d]">Покупателям</p><h1 className="mt-4 text-4xl font-black tracking-[-0.05em] sm:text-6xl">Контакты</h1><p className="mt-6 max-w-2xl text-lg leading-8 text-[#6e655e]">Поможем выбрать кофе, уточнить заказ и доставку. Свяжитесь удобным способом.</p><div className="mt-12 grid gap-5 lg:grid-cols-2"><section className="rounded-[28px] bg-white p-7 shadow-[0_18px_55px_rgba(45,27,17,0.06)]"><div className="space-y-6"><Contact icon={Phone} title="Телефоны"><a href="tel:+79384537060" className="hover:text-[#5b328a]">+7 (938) 453-70-60</a><br /><a href="tel:+79184017060" className="hover:text-[#5b328a]">+7 (918) 401-70-60</a></Contact><Contact icon={Mail} title="Почта"><a href="mailto:10coffee@mail.ru" className="hover:text-[#5b328a]">10coffee@mail.ru</a></Contact><Contact icon={MessageCircle} title="MAX"><a href="tel:+79384537060" className="hover:text-[#5b328a]">+7 (938) 453-70-60</a></Contact><Contact icon={MapPin} title="Самовывоз">г. Сочи, ул. Пластунская, 79/1, пом. 1<br /><span className="text-sm text-[#6e655e]">Пн–Пт: 9:00–18:00</span></Contact></div><div className="mt-8 grid gap-3 sm:grid-cols-2"><a href="https://t.me/Tencoffeesochi" target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 rounded-2xl bg-[#e8f4fd] px-4 py-3 text-sm font-black text-[#1677b8] transition hover:bg-[#d4ecfa]"><Send className="h-4 w-4" />Telegram</a><a href={MAX_URL} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 rounded-2xl bg-[#f3edfb] px-4 py-3 text-sm font-black text-[#5b328a] transition hover:bg-[#e8ddf7]"><MessageCircle className="h-4 w-4" />MAX</a><a href="https://vk.com/10coffee" target="_blank" rel="noopener noreferrer" className="rounded-2xl border border-black/10 px-4 py-3 text-center text-sm font-black transition hover:border-[#5b328a] hover:text-[#5b328a]">ВКонтакте</a><a href="https://www.instagram.com/10coffee.ru?igsh=NmMzbDN2OW5xaXVp" target="_blank" rel="noopener noreferrer" className="rounded-2xl border border-black/10 px-4 py-3 text-center text-sm font-black transition hover:border-[#5b328a] hover:text-[#5b328a]">Instagram</a></div></section><section className="min-h-[420px] overflow-hidden rounded-[28px] bg-white shadow-[0_18px_55px_rgba(45,27,17,0.06)]"><iframe className="h-full min-h-[420px] w-full border-0" src="https://yandex.ru/map-widget/v1/?ll=39.735351%2C43.603466&z=17&pt=39.735351,43.603466,pm2rdm" title="10coffee на карте" allowFullScreen /></section></div></article></main>
}

function Contact({ icon: Icon, title, children }: { icon: typeof Phone; title: string; children: React.ReactNode }) {
  return <div className="flex gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#f8f5f1] text-[#e6610d]"><Icon className="h-4 w-4" /></span><div><p className="text-xs font-black uppercase tracking-[0.16em] text-[#91867d]">{title}</p><div className="mt-1 text-base font-bold leading-6">{children}</div></div></div>
}
