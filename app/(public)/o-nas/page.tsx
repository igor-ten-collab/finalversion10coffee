import SiteHeader from "@/components/landing/SiteHeader"
import LandingFooter from "@/components/landing/LandingFooter"
import styles from "./o-nas.module.css"

export const metadata = {
  title: "О нас | 10кофе",
  description: "Компания 10кофе — более 10 лет развиваем культуру кофе в России. Собственная обжарка, школа бариста, сервис оборудования.",
}

const STATS = [
  { number: "10", label: "лет радуем вкусным кофе и сервисом" },
  { number: "30К", label: "выполненных заказов по всей стране" },
  { number: ">300", label: "кофеен ежедневно варят наш кофе" },
  { number: "", label: "скидки постоянным покупателям" },
]

const DIRECTIONS = [
  {
    icon: "☕",
    name: "Обжарка кофе",
    desc: "Собственный цех с 2014 года. Обжариваем каждый день на профессиональном оборудовании под ваши вкусовые предпочтения.",
  },
  {
    icon: "⚙️",
    name: "Сервис оборудования",
    desc: "Официальные дилеры Simonelli, Astoria, Baratza. Монтаж, ремонт и обслуживание оборудования любой сложности с гарантией.",
  },
  {
    icon: "🎓",
    name: "Школа бариста",
    desc: "С 2019 года обучаем барменов и бариста. После курса ученик в первый же день уверенно встаёт за бар.",
  },
]

export default function ONasPage() {
  return (
    <>
      <SiteHeader />

      {/* Hero */}
      <section className={styles.hero}>
        <div className={styles.heroContent}>
          <p className={styles.heroLabel}>Компания</p>
          <h1 className={styles.heroTitle}>О нас</h1>
          <p className={styles.heroSubtitle}>
            Более 10 лет развиваем культуру кофе в России — от зерна до чашки.
          </p>
        </div>
      </section>

      {/* Stats */}
      <section className={styles.stats}>
        <div className={styles.statsInner}>
          {STATS.map((s) => (
            <div key={s.number} className={styles.statItem}>
              <div className={styles.statNumber}>{s.number}</div>
              <div className={styles.statLabel}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Story */}
      <section className={styles.story}>
        <div className={styles.storyInner}>
          <div className={styles.storyLeft}>
            <div className={styles.stickySide}>
              <p className={styles.sectionLabel}>История</p>
              <h2 className={styles.sectionTitle}>Наша история</h2>
            </div>
          </div>
          <div className={styles.storyRight}>
            <p className={styles.storyPara}>
              Компания 10coffee вот уже более десяти лет активно развивает культуру кофе в России,
              участвует в чемпионатах бариста и является сертифицированными судьями.
              Наша команда — это профессионалы своего дела.
            </p>
            <p className={styles.storyPara}>
              В <strong>2014 году</strong> мы открыли собственный цех по обжарке кофе,
              в <strong>2017 году</strong> переехали в Сочи. Цель компании 10coffee —
              поделиться с вами удивительным миром и вкусовым многообразием кофе,
              подарить возможность совершать маленькие открытия каждый день,
              наполняя себя новыми впечатлениями.
            </p>
            <p className={styles.storyPara}>
              Мы обжариваем кофе каждый день на профессиональном оборудовании,
              с учетом ваших вкусовых предпочтений, максимально раскрывая его вкус.
              Мы не делаем шаблоны — мы создаём свой уникальный продукт, который вы так любите.
            </p>
            <p className={styles.storyPara}>
              Одним из важных направлений нашей компании является ремонт и сервисное
              обслуживание кофейного оборудования. Наши специалисты имеют богатый опыт
              монтажа, ремонта и обслуживания оборудования разной категории сложности —
              в короткие сроки диагностируем и устраняем неполадку, не нарушая процесс
              работы вашего заведения. Мы являемся официальными дилерами{" "}
              <strong>Simonelli, Astoria, Baratza</strong> и используем только оригинальные
              запчасти с гарантией качества.
            </p>
            <p className={styles.storyPara}>
              В <strong>2019 году</strong> в Сочи мы открыли «школу бариста», чтобы
              повышать уровень культуры кофе в заведениях, обучая и развивая барменов
              и бариста. Для кофеен предлагаем обучение сотрудников по их собственным
              тех. картам, стандартам качества и сервиса. После обучения в нашей школе
              бариста в первый же день уверенно встаёт за бар.
            </p>
          </div>
        </div>
      </section>

      {/* Directions */}
      <section className={styles.directions}>
        <div className={styles.directionsInner}>
          <h2 className={styles.directionsTitle}>Наши направления</h2>
          <div className={styles.directionGrid}>
            {DIRECTIONS.map((d) => (
              <div key={d.name} className={styles.directionCard}>
                <div className={styles.directionIcon}>{d.icon}</div>
                <div className={styles.directionName}>{d.name}</div>
                <p className={styles.directionDesc}>{d.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <LandingFooter />
    </>
  )
}
