import SiteHeader from "@/components/landing/SiteHeader"
import LandingFooter from "@/components/landing/LandingFooter"
import TrainingForm from "@/components/landing/TrainingForm"
import styles from "./training.module.css"

export const metadata = {
  title: "Обучение бариста | 10coffee",
  description:
    "Курс «Основы профессии бариста» — 3-дневное обучение: эспрессо, молоко, альтернативное заваривание. Запишитесь прямо сейчас!",
}

const COURSE_DAYS = [
  {
    day: "День 1",
    title: "Эспрессо",
    topics: [
      "Теория кофе: от зерна к чашке",
      "Настройка помола и экстракция",
      "Работа с кофемашиной",
      "Приготовление идеального эспрессо",
    ],
  },
  {
    day: "День 2",
    title: "Молоко",
    topics: [
      "Техника взбивания молока",
      "Латте-арт: базовые элементы",
      "Капучино, флэт-уайт, латте",
      "Альтернативное молоко",
    ],
  },
  {
    day: "День 3",
    title: "Заваривание",
    topics: [
      "Альтернативные способы заваривания",
      "Воронка, аэропресс, кемекс",
      "Каппинг и оценка вкуса",
      "Работа с листами оценки SCA",
    ],
  },
]

const FEATURES = [
  {
    title: "Практика",
    description: "80% курса — работа руками на профессиональном оборудовании",
  },
  {
    title: "Сертификат",
    description: "По окончании — сертификат о прохождении курса",
  },
  {
    title: "Гибкий формат",
    description: "Можно выбрать любой из модулей или пройти все 3 сразу",
  },
  {
    title: "Малые группы",
    description: "До 6 человек — индивидуальный подход к каждому",
  },
]

export default function TrainingPage() {
  return (
    <>
      <SiteHeader />

      {/* Hero */}
      <section className={styles.hero}>
        <div className={styles.heroContent}>
          <p className={styles.heroLabel}>Образование</p>
          <h1 className={styles.heroTitle}>
            Обучение
            <br />
            бариста
          </h1>
          <p className={styles.heroSubtitle}>
            Основы профессии бариста. Обучение проходит в течение 3 дней.
          </p>
        </div>
      </section>

      {/* About */}
      <section className={styles.about}>
        <div className={styles.aboutInner}>
          <div className={styles.aboutText}>
            <h2 className={styles.sectionTitle}>Для кого этот курс</h2>
            <p className={styles.aboutDesc}>
              Данный курс подходит тем, кто решил освоить профессию бариста и не
              знает с чего начать или уже работает, но знаний и навыков
              недостаточно. На данном курсе мы научим Вас разбираться в кофе,
              настраивать и вкусно готовить эспрессо, взбивать молоко и рисовать
              латте арт. Также вы узнаете что такое «воронка», «аэропресс»,
              «каппинг», научим вас пользоваться различными кофейными девайсами
              и оценивать кофе как профессионалы.
            </p>
          </div>
          <div className={styles.features}>
            {FEATURES.map((f) => (
              <div key={f.title} className={styles.feature}>
                <h4 className={styles.featureTitle}>{f.title}</h4>
                <p className={styles.featureDesc}>{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Program */}
      <section className={styles.program}>
        <h2 className={styles.sectionTitle}>Программа курса</h2>
        <p className={styles.programSubtitle}>
          Данный курс состоит из 3-х модулей по одному модулю на каждый день.
          Вы можете выбрать и пройти любой из модулей на ваш выбор или все 3 сразу.
        </p>
        <div className={styles.days}>
          {COURSE_DAYS.map((day) => (
            <div key={day.day} className={styles.dayCard}>
              <span className={styles.dayBadge}>{day.day}</span>
              <h3 className={styles.dayTitle}>{day.title}</h3>
              <ul className={styles.dayTopics}>
                {day.topics.map((topic) => (
                  <li key={topic}>{topic}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Signup CTA */}
      <section className={styles.signup}>
        <div className={styles.signupInner}>
          <div className={styles.signupText}>
            <h2 className={styles.signupTitle}>Записаться</h2>
            <p className={styles.signupDesc}>
              Оставьте свои контакты и мы свяжемся с вами для записи на ближайший курс
            </p>
          </div>
          <TrainingForm
            className={styles.signupForm}
            inputClassName={styles.signupInput}
            buttonClassName={styles.signupButton}
            disclaimerClassName={styles.signupDisclaimer}
          />
        </div>
      </section>

      <LandingFooter />
    </>
  )
}
