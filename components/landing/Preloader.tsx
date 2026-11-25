"use client";

import { useEffect, useMemo, useState } from "react";
import { useLenis } from "lenis/react";
import styles from "./Preloader.module.css";

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const EXIT_ANIMATION_MS = 700;
const SESSION_KEY = "10coffee_preloader_shown";

function hasSeenPreloader(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function markPreloaderSeen() {
  try {
    sessionStorage.setItem(SESSION_KEY, "1");
  } catch {
    // ignore
  }
}

interface PreloaderProps {
  onAnimationComplete?: () => void;
}

export default function Preloader({ onAnimationComplete }: PreloaderProps) {
  const lenis = useLenis();

  // SSR-гидрация: на сервере и при первом клиентском рендере прелоадер
  // не выводится (null), иначе sessionStorage даёт рассинхрон HTML↔state.
  // Решение о показе принимаем только после монтирования.
  const [isVisible, setIsVisible] = useState(false);
  const [isScrollLocked, setIsScrollLocked] = useState(false);
  const [progress, setProgress] = useState(0);
  const [hasFinishedLoading, setHasFinishedLoading] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (!hasSeenPreloader()) {
      setIsVisible(true);
      setIsScrollLocked(true);
    }
  }, []);

  useEffect(() => {
    if (!isScrollLocked) {
      if (lenis) lenis.start();
      document.body.style.overflow = "";
      return;
    }

    if (lenis) lenis.stop();
    document.body.style.overflow = "hidden";

    return () => {
      if (lenis) lenis.start();
      document.body.style.overflow = "";
    };
  }, [lenis, isScrollLocked]);

  useEffect(() => {
    if (!isVisible) return;

    let frameId: number | null = null;
    const startTime = performance.now();
    const duration = 2600;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const ratio = clamp(elapsed / duration, 0, 1);
      const percent = Math.round(ratio * 100);

      setProgress(percent);

      if (percent >= 100) {
        setHasFinishedLoading(true);
        return;
      }

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [isVisible]);

  // Auto-exit after loading completes
  useEffect(() => {
    if (!hasFinishedLoading || isExiting) return;

    const timeout = window.setTimeout(() => {
      setIsExiting(true);
      setIsScrollLocked(false);
      markPreloaderSeen();

      window.setTimeout(() => {
        setIsVisible(false);
        if (onAnimationComplete) onAnimationComplete();
      }, EXIT_ANIMATION_MS);
    }, 400);

    return () => clearTimeout(timeout);
  }, [hasFinishedLoading, isExiting, onAnimationComplete]);

  const loadingText = useMemo(() => `${progress}%`, [progress]);

  if (!isVisible) return null;

  return (
    <section
      className={`${styles.preloader} ${isExiting ? styles.isExiting : ""}`}
      aria-label="Website preloader"
    >
      <div className={styles.preloaderInner}>
        <div className={styles.titleWrap}>
          <img src="/logo_text.svg" className={styles.logoBase} alt="" draggable={false} />
          <div className={styles.titleFill} style={{ width: `${progress}%` }}>
            <img src="/logo_text.svg" className={styles.logoFill} alt="" draggable={false} />
          </div>
        </div>

        <div className={styles.actionSlot}>
          <p
            className={`${styles.loading} ${hasFinishedLoading ? styles.loadingHidden : ""}`}
            aria-live="polite"
          >
            {loadingText}
          </p>
        </div>
      </div>
    </section>
  );
}
