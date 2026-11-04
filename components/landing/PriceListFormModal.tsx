"use client";

import { useActionState, useState, useEffect } from "react";
import PhoneInput from "@/components/shared/phone-input";
import { submitPriceListRequest, type PriceListState } from "@/lib/actions/price-list";
import styles from "./PriceListFormModal.module.css";

const initialState: PriceListState = { success: false };

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function PriceListFormModal({ isOpen, onClose }: Props) {
  const [state, formAction, isPending] = useActionState(
    submitPriceListRequest,
    initialState,
  );
  const [agreed, setAgreed] = useState(false);
  const showSuccess = state.success;

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose} aria-label="Закрыть">
          &times;
        </button>

        {showSuccess ? (
          <div className={styles.success}>
            <div className={styles.successIcon}>✓</div>
            <h4 className={styles.successTitle}>
              {state.emailSent
                ? (state.name ? `${state.name}, письмо отправлено!` : "Письмо отправлено!")
                : (state.name ? `${state.name}, заявка получена!` : "Заявка получена!")}
            </h4>
            <p className={styles.successText}>
              {state.emailSent ? <>
                Письмо с прайс-листом отправлено на указанный email.<br />
                Если письмо не пришло — проверьте папку «Спам».
              </> : <>
                Заявка сохранена, но отправить прайс-лист не удалось.<br />
                Свяжитесь с нами, чтобы получить файл.
              </>}
            </p>
            <button className={styles.btn} onClick={onClose}>Закрыть</button>
          </div>
        ) : (
          <>
            <h3 className={styles.title}>Получить прайс-лист</h3>
            <p className={styles.subtitle}>
              Оставьте контакты и мы отправим актуальный прайс-лист
            </p>

            <form action={formAction} className={styles.form}>
              <input type="text" name="name" placeholder="Ваше имя" required className={styles.input} />
              <input type="email" name="email" placeholder="Email" required className={styles.input} />
              <PhoneInput name="phone" required className={styles.input} />
              <input type="text" name="company" placeholder="Компания (необязательно)" className={styles.input} />
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
              <button type="submit" className={styles.btn} disabled={isPending || !agreed}>
                {isPending ? "Отправка..." : "Отправить"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
