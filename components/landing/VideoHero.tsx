"use client";

import Copy from "./_shared/Copy";
import styles from "./VideoHero.module.css";

export default function VideoHero() {
  return (
    <section className={styles.hero}>
      <div className={styles.heroMedia}>
        <video
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster="/hero-burner-v2.jpg"
        >
          <source src="/hero-burner-v2.mp4" type="video/mp4" />
        </video>
      </div>

      <div className={styles.heroOverlay} />

      <div className={styles.heroContainer}>
        <Copy type="words" animateOnScroll={false} delay={0.85}>
          <h1>Свежеобжаренный кофе из Сочи</h1>
        </Copy>
        <Copy type="words" animateOnScroll={false} delay={1.1}>
          <p className={styles.heroSub}>Оптовая платформа и интернет-магазин кофе, чая и аксессуаров с доставкой по всей России</p>
        </Copy>
      </div>
    </section>
  );
}
