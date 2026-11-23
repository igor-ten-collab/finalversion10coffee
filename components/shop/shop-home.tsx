"use client"

import Link from "next/link"
import { ArrowRight, Coffee, FlaskConical, Leaf, PackageCheck, Quote, ShieldCheck, Sparkles, Truck } from "lucide-react"
import { ShopHeader } from "./shop-header"
import { getShopProductCardTasteMetric, ShopProductCard } from "./shop-catalog"
import { FaqQuestionForm } from "./faq-question-form"
import { formatProductCount } from "@/lib/utils/plural"
import type { PublishedFaq } from "@/lib/actions/faqs"
import type { Product, ProductTypeOption } from "@/types"

const CATEGORY_STYLES = [
  "bg-[#f0d8bf]",
  "bg-[#dfe6cb]",
  "bg-[#e3d8ec]",
  "bg-[#d8e4e6]",
]

const CATEGORY_ICONS = [Coffee, Leaf, Sparkles, FlaskConical]

export function ShopHome({ products, productTypes, faqs, favoriteIds = [] }: { products: Product[]; productTypes: ProductTypeOption[]; faqs: PublishedFaq[]; favoriteIds?: string[] }) {
  const visibleTypes = productTypes
    .filter((type) => !["sluzhebnoe", "oprihodovanie-i-to"].includes(type.slug))
    .slice(0, 4)
  const popular = products
    .filter((product) => product.is_popular)
    .sort((a, b) => a.sort_order - b.sort_order)
    .slice(0, 4)
  const newest = [...products]
    .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
    .slice(0, 4)
  const featuredProduct = popular[0] || newest[0]
  const reviews = products
    .flatMap((product) => (product.reviews || []).map((review) => ({ ...review, productName: product.name })))
    .filter((review) => review.comment && review.status !== "rejected" && review.status !== "pending")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 3)
  return (
    <main className="min-h-screen bg-[#f8f5f1] text-[#1d1d1b]">
      <ShopHeader products={products} productTypes={productTypes} />
      <h1 className="sr-only">Интернет-магазин свежеобжаренного кофе, чая и аксессуаров 10coffee</h1>

      <section id="categories" className="mx-auto max-w-[1480px] scroll-mt-28 px-5 pb-24 pt-8 lg:px-10 lg:pt-12">
        <div className="grid items-stretch gap-5 lg:grid-cols-12 lg:grid-rows-[auto_1fr]">
          <div className="lg:col-span-8 lg:row-start-1">
            <SectionHeading eyebrow="Каталог" title="Выберите свою категорию" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:col-span-8 lg:row-start-2 lg:mt-8 lg:grid-rows-2">
              {visibleTypes.map((type, index) => {
                const Icon = CATEGORY_ICONS[index] || Coffee
                return (
                  <Link key={type.id} href={`/${type.slug}`} className={`group relative min-h-[280px] overflow-hidden rounded-[30px] p-7 lg:min-h-0 ${CATEGORY_STYLES[index] || CATEGORY_STYLES[0]}`}>
                    <Icon className="absolute -bottom-4 -right-4 h-40 w-40 text-[#1d1d1b]/10 transition duration-500 group-hover:rotate-6 group-hover:scale-110" />
                    <div className="relative z-10 flex h-full min-h-[226px] flex-col justify-between text-[#1d1d1b] lg:min-h-0">
                      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/80"><Icon className="h-5 w-5" /></span>
                      <div>
                        <p className="text-sm font-bold text-[#1d1d1b]/55">{formatProductCount(type.product_count)}</p>
                        <h2 className="mt-1 text-3xl font-black tracking-[-0.04em]">{type.name}</h2>
                        <span className="mt-4 flex items-center gap-2 text-sm font-black">Смотреть <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" /></span>
                      </div>
                    </div>
                  </Link>
                )
              })}
          </div>

          {featuredProduct && (
            <>
              <div className="flex min-w-0 items-end justify-between gap-4 lg:col-span-4 lg:col-start-9 lg:row-start-1">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.22em] text-[#e6610d]">Рекомендуем</p>
                  <h2 className="mt-3 text-4xl font-black tracking-[-0.05em]">Товар дня</h2>
                </div>
                <Link href={`/shop/${featuredProduct.slug}`} className="hidden items-center gap-2 text-sm font-black text-[#5b328a] sm:flex">Подробнее <ArrowRight className="h-4 w-4" /></Link>
              </div>
              <div className="min-w-0 lg:col-span-4 lg:col-start-9 lg:row-start-2 lg:mt-8 [&>article]:h-full">
                <ShopProductCard product={featuredProduct} isFavorite={favoriteIds.includes(featuredProduct.id)} tasteMetric={getShopProductCardTasteMetric(featuredProduct)} />
              </div>
            </>
          )}
        </div>
      </section>

      {popular.length > 0 && (
        <section className="mx-auto max-w-[1480px] px-5 pb-24 lg:px-10">
          <SectionHeading eyebrow="Выбор покупателей" title="Популярные товары" href="/shop?coll=popular" linkLabel="Смотреть все" />
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{popular.map((product) => <ShopProductCard key={product.id} product={product} isFavorite={favoriteIds.includes(product.id)} tasteMetric={getShopProductCardTasteMetric(product)} />)}</div>
        </section>
      )}

      {newest.length > 0 && (
        <section className="bg-[#eee7df] py-24">
          <div className="mx-auto max-w-[1480px] px-5 lg:px-10">
            <SectionHeading eyebrow="Недавно в каталоге" title="Новинки" href="/kofe?coll=new" linkLabel="Все новинки" />
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{newest.map((product) => <ShopProductCard key={product.id} product={product} isFavorite={favoriteIds.includes(product.id)} tasteMetric={getShopProductCardTasteMetric(product)} />)}</div>
          </div>
        </section>
      )}

      <section className="mx-auto max-w-[1480px] px-5 py-24 lg:px-10">
        <SectionHeading eyebrow="От заказа до чашки" title="Как мы работаем" />
        <div className="mt-9 grid gap-px overflow-hidden rounded-[30px] bg-black/[0.08] md:grid-cols-4">
          {[
            { icon: Coffee, number: "01", title: "Вы выбираете", text: "Сорт, фасовку и нужный помол прямо в карточке товара." },
            { icon: PackageCheck, number: "02", title: "Мы обжариваем", text: "Комплектуем заказ и бережно упаковываем каждую позицию." },
            { icon: Truck, number: "03", title: "Отправляем", text: "Передаём заказ в доставку или готовим к самовывозу." },
            { icon: ShieldCheck, number: "04", title: "Всегда на связи", text: "Помогаем с выбором, отвечаем на вопросы и консультируем." },
          ].map((step) => (
            <div key={step.number} className="bg-white p-8 lg:p-10">
              <div className="flex items-center justify-between"><step.icon className="h-7 w-7 text-[#e6610d]" /><span className="text-xs font-black text-[#b7ada5]">{step.number}</span></div>
              <h3 className="mt-12 text-2xl font-black tracking-[-0.03em]">{step.title}</h3>
              <p className="mt-3 text-sm leading-6 text-[#6e655e]">{step.text}</p>
            </div>
          ))}
        </div>
      </section>

      {reviews.length > 0 && (
        <section className="bg-[#5b328a] py-24 text-white">
          <div className="mx-auto max-w-[1480px] px-5 lg:px-10">
            <SectionHeading eyebrow="Проверено покупателями" title="Отзывы наших клиентов" light />
            <div className="mt-9 grid gap-5 lg:grid-cols-3">
              {reviews.map((review) => (
                <article key={review.id} className="flex min-h-[280px] flex-col rounded-[28px] bg-white/10 p-7 ring-1 ring-white/15">
                  <Quote className="h-8 w-8 text-[#f58a42]" />
                  <p className="mt-6 text-lg font-semibold leading-8">{review.comment}</p>
                  <div className="mt-auto flex items-end justify-between gap-4 pt-8">
                    <div><p className="font-black">{review.author_name || "Покупатель 10coffee"}</p><p className="mt-1 text-xs text-white/60">{review.productName}</p></div>
                    <p className="text-sm font-black text-[#ffd166]">{"★".repeat(Math.round(review.rating || 5))}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      <section id="faq" className="mx-auto grid max-w-[1480px] gap-10 px-5 py-24 lg:grid-cols-[0.65fr_1.35fr] lg:px-10">
        <div><p className="text-xs font-black uppercase tracking-[0.22em] text-[#e6610d]">Помощь покупателю</p><h2 className="mt-3 text-4xl font-black tracking-[-0.05em] sm:text-6xl">Частые вопросы</h2><p className="mt-5 max-w-sm text-base leading-7 text-[#6e655e]">Не нашли ответ? Напишите нам — поможем выбрать товар и уточнить детали заказа.</p><FaqQuestionForm /></div>
        <div className="divide-y divide-black/[0.09] border-y border-black/[0.09]">
          {faqs.map((item) => <details key={item.id} className="group py-1"><summary className="flex cursor-pointer list-none items-center justify-between gap-5 py-6 text-lg font-black"><span>{item.question}</span><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-xl transition group-open:rotate-45">+</span></summary><p className="max-w-3xl pb-7 pr-12 text-sm leading-7 text-[#6e655e]">{item.answer}</p></details>)}
          {faqs.length === 0 && <p className="py-7 text-sm leading-7 text-[#6e655e]">Скоро здесь появятся ответы на частые вопросы.</p>}
        </div>
      </section>
    </main>
  )
}

function SectionHeading({ eyebrow, title, href, linkLabel, light = false }: { eyebrow: string; title: string; href?: string; linkLabel?: string; light?: boolean }) {
  return <div className="flex items-end justify-between gap-6"><div><p className={`text-xs font-black uppercase tracking-[0.22em] ${light ? "text-[#f5aa76]" : "text-[#e6610d]"}`}>{eyebrow}</p><h2 className="mt-3 text-4xl font-black tracking-[-0.05em] sm:text-5xl">{title}</h2></div>{href && <Link href={href} className={`hidden items-center gap-2 text-sm font-black sm:flex ${light ? "text-white" : "text-[#5b328a]"}`}>{linkLabel}<ArrowRight className="h-4 w-4" /></Link>}</div>
}
