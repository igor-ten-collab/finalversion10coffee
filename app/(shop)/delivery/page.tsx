import type { Metadata } from "next"
import { ShopHeader } from "@/components/shop/shop-header"
import { getCachedShopProducts, getProductTypes } from "@/lib/actions/products"

export const metadata: Metadata = {
  title: "Доставка и оплата — 10coffee",
  description: "Способы доставки, получения и оплаты заказов интернет-магазина 10coffee.",
}

export const dynamic = "force-dynamic"

export default async function DeliveryPage() {
  const [products, productTypes] = await Promise.all([getCachedShopProducts(), getProductTypes()])

  return (
    <main className="min-h-screen bg-[#f8f5f1] text-[#1d1d1b]">
      <ShopHeader products={products} productTypes={productTypes} />
      <article className="mx-auto max-w-5xl px-5 py-16 lg:px-10 lg:py-24">
        <p className="text-xs font-black uppercase tracking-[0.22em] text-[#e6610d]">Покупателям</p>
        <h1 className="mt-4 text-4xl font-black tracking-[-0.04em] sm:text-6xl">Доставка и оплата</h1>
        <p className="mt-6 max-w-3xl text-lg leading-8 text-[#6e655e]">
          Мы доставляем заказы по всей России. В Сочи доступен самовывоз. Выберите удобный способ получения при оформлении заказа.
        </p>

        <div className="mt-12 grid gap-5 md:grid-cols-3">
          <section className="rounded-[28px] bg-white p-7 shadow-[0_18px_55px_rgba(45,27,17,0.06)]">
            <h2 className="text-xl font-black">СДЭК</h2>
            <p className="mt-3 text-sm leading-6 text-[#6e655e]">Доставка по России до пункта выдачи или курьером там, где такая услуга доступна. Срок и стоимость зависят от города, тарифа и параметров заказа.</p>
          </section>
          <section className="rounded-[28px] bg-white p-7 shadow-[0_18px_55px_rgba(45,27,17,0.06)]">
            <h2 className="text-xl font-black">Доставка по Сочи</h2>
            <p className="mt-3 text-sm leading-6 text-[#6e655e]">Курьерская доставка по согласованному адресу в Сочи и Адлере. Доступность, дата, временной интервал и стоимость подтверждаются при обработке заказа.</p>
          </section>
          <section className="rounded-[28px] bg-white p-7 shadow-[0_18px_55px_rgba(45,27,17,0.06)]">
            <h2 className="text-xl font-black">Самовывоз</h2>
            <p className="mt-3 text-sm leading-6 text-[#6e655e]">Бесплатно по адресу: г. Сочи, ул. Пластунская, д. 79/1, пом. 1. Получение возможно после уведомления о готовности заказа.</p>
          </section>
        </div>

        <div className="mt-12 space-y-5">
          <section className="rounded-[28px] border border-black/[0.07] bg-white/70 p-7 sm:p-9">
            <h2 className="text-2xl font-black">Стоимость и сроки</h2>
            <div className="mt-4 space-y-3 text-sm leading-7 text-[#554b43]">
              <p>Стоимость товаров фиксируется в корзине на момент оформления. Если стоимость доставки не указана в итоговой сумме заказа, она рассчитывается отдельно по тарифу перевозчика или городской доставки и сообщается покупателю до передачи заказа в доставку.</p>
              <p>Ориентировочный срок зависит от населённого пункта и выбранного способа. Заказы обрабатываются в рабочее время: понедельник–пятница, с 9:00 до 18:00. О готовности к самовывозу или передаче перевозчику мы сообщаем по телефону или электронной почте.</p>
            </div>
          </section>

          <section className="rounded-[28px] border border-black/[0.07] bg-white/70 p-7 sm:p-9">
            <h2 className="text-2xl font-black">Оплата</h2>
            <div className="mt-4 space-y-3 text-sm leading-7 text-[#554b43]">
              <p>Заказ можно оплатить банковской картой онлайн через защищённую платёжную страницу YooKassa. Доступные способы оплаты отображаются при оформлении.</p>
              <p>Платёжные данные вводятся на стороне банка и не передаются интернет-магазину. После успешной оплаты мы отправим подтверждение на указанную электронную почту.</p>
            </div>
          </section>

          <section className="rounded-[28px] border border-black/[0.07] bg-white/70 p-7 sm:p-9">
            <h2 className="text-2xl font-black">Получение заказа</h2>
            <div className="mt-4 space-y-3 text-sm leading-7 text-[#554b43]">
              <p>При получении проверьте количество мест, целостность упаковки и отсутствие видимых повреждений. При обнаружении повреждений сообщите об этом представителю службы доставки и свяжитесь с нами.</p>
              <p>Для уточнения заказа используйте номер из письма-подтверждения. Телефон: <a href="tel:+79384537060" className="font-bold text-[#5b328a]">+7 (938) 453-70-60</a>, email: <a href="mailto:10coffee@mail.ru" className="font-bold text-[#5b328a]">10coffee@mail.ru</a>.</p>
            </div>
          </section>

          <section className="rounded-[28px] border border-black/[0.07] bg-white/70 p-7 sm:p-9">
            <h2 className="text-2xl font-black">Отказ и возврат</h2>
            <div className="mt-4 space-y-3 text-sm leading-7 text-[#554b43]">
              <p>Покупатель вправе отказаться от заказа до его передачи, а после передачи — в сроки и при соблюдении условий, установленных законодательством Российской Федерации. Для товара надлежащего качества должны быть сохранены товарный вид и потребительские свойства.</p>
              <p>Чтобы оформить обращение, напишите на 10coffee@mail.ru и укажите номер заказа, товар и причину обращения. Денежные средства возвращаются тем же способом, которым была произведена оплата, если иной способ не согласован сторонами.</p>
            </div>
          </section>
        </div>
      </article>
    </main>
  )
}
