"use client";

import { useActionState, useState } from "react";
import Copy from "./_shared/Copy";
import PhoneInput from "@/components/shared/phone-input";
import { submitPriceListRequest, type PriceListState } from "@/lib/actions/price-list";
import styles from "./PriceListForm.module.css";

const initialState: PriceListState = { success: false };

export default function PriceListForm() {
  const [state, formAction, isPending] = useActionState(
    submitPriceListRequest,
    initialState,
  );
  const [agreed, setAgreed] = useState(false);
  const [successDismissed, setSuccessDismissed] = useState(false);
  const showModal = state.success && !successDismissed;

  return (
    <section className={styles.section} id="price-list-form">
      <div className={styles.container}>
        <Copy type="words" animateOnScroll>
          <h3>Получить прайс-лист</h3>
        </Copy>

        <Copy type="lines" animateOnScroll>
          <p className="md">
            Оставьте контакты и мы отправим актуальный прайс-лист
          </p>
        </Copy>

        <form action={formAction} className={styles.form}>
          <input
            type="text"
            name="name"
            placeholder="Ваше имя"
            required
            className={styles.input}
          />
          <input
            type="email"
            name="email"
            placeholder="Email"
            required
            className={styles.input}
          />
          <PhoneInput name="phone" required className={styles.input} />
          <input
            type="text"
            name="company"
            placeholder="Компания (необязательно)"
            className={styles.input}
          />
          {state.error && <p className={styles.error}>{state.error}</p>}
          <label className={styles.privacy}>
            <input
              type="checkbox"
              name="consent"
              required
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className={styles.privacyCheck}
            />
            <span className={styles.privacyText}>
              Принимаю{" "}
              <a href="/Политика конфиденциальности.pdf" target="_blank" rel="noopener noreferrer">
                политику конфиденциальности
              </a>{" "}
              и{" "}
              <a href="/Политика обработки персональных данных пользователей сайта.pdf" target="_blank" rel="noopener noreferrer">
                правила обработки персональных данных
              </a>
            </span>
          </label>
          <button
            type="submit"
            className={styles.submitBtn}
            disabled={isPending || !agreed}
          >
            {isPending ? "Отправка..." : "Отправить"}
          </button>
        </form>
      </div>

      {showModal && (
        <div className={styles.modalOverlay} onClick={() => setSuccessDismissed(true)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalIcon}>✓</div>
            <h4 className={styles.modalTitle}>
              {state.emailSent
                ? (state.name ? `${state.name}, письмо отправлено!` : "Письмо отправлено!")
                : (state.name ? `${state.name}, заявка получена!` : "Заявка получена!")}
            </h4>
            <p className={styles.modalText}>
              {state.emailSent ? <>
                Письмо с прайс-листом отправлено на указанный email.<br />
                Если письмо не пришло — проверьте папку «Спам».
              </> : <>
                Заявка сохранена, но отправить прайс-лист не удалось.<br />
                Свяжитесь с нами, чтобы получить файл.
              </>}
            </p>
            <button className={styles.modalClose} onClick={() => setSuccessDismissed(true)}>
              Закрыть
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
