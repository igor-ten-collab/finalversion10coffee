"use client";

import { useActionState, useEffect, useState } from "react";
import PhoneInput from "@/components/shared/phone-input";
import { submitContactRequest, type ContactFormState } from "@/lib/actions/contact";
import styles from "./PriceListFormModal.module.css";

const initialState: ContactFormState = { success: false };

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

function ContactFormContent({ onClose }: Pick<Props, "onClose">) {
  const [state, formAction, isPending] = useActionState(
    submitContactRequest,
    initialState,
  );
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-form-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть">
          &times;
        </button>

        {state.success ? (
          <div className={styles.success} role="status">
            <div className={styles.successIcon}>✓</div>
            <h3 className={styles.successTitle} id="contact-form-title">
              Спасибо{state.name ? `, ${state.name}` : ""}!
            </h3>
            <p className={styles.successText}>
              Сообщение сохранено. Мы свяжемся с вами по указанным контактам.
            </p>
            <button type="button" className={styles.btn} onClick={onClose}>Закрыть</button>
          </div>
        ) : (
          <>
            <h3 className={styles.title} id="contact-form-title">Написать нам</h3>
            <p className={styles.subtitle}>
              Оставьте сообщение и укажите email или телефон для ответа
            </p>

            <form
              action={formAction}
              className={styles.form}
              aria-busy={isPending}
              onReset={() => setAgreed(false)}
            >
              <input
                type="text"
                name="name"
                placeholder="Ваше имя"
                aria-label="Ваше имя"
                autoComplete="name"
                autoFocus
                required
                minLength={2}
                maxLength={120}
                className={styles.input}
              />
              <input
                type="email"
                name="email"
                placeholder="Email"
                aria-label="Email"
                autoComplete="email"
                maxLength={254}
                className={styles.input}
              />
              <PhoneInput name="phone" className={styles.input} />
              <textarea
                name="message"
                placeholder="Ваше сообщение"
                aria-label="Ваше сообщение"
                required
                minLength={10}
                maxLength={5000}
                className={styles.input}
                style={{ resize: "vertical", minHeight: 110 }}
              />
              {state.error && <p className={styles.error} role="alert">{state.error}</p>}
              <label className={styles.privacy}>
                <input
                  type="checkbox"
                  name="consent"
                  required
                  checked={agreed}
                  onChange={(event) => setAgreed(event.target.checked)}
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
                {isPending ? "Отправка..." : "Отправить сообщение"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

export default function ContactFormModal({ isOpen, onClose }: Props) {
  if (!isOpen) return null;
  return <ContactFormContent onClose={onClose} />;
}
