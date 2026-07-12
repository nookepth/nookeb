'use client';

import { useEffect, useRef } from 'react';

interface RevealProps {
  children: React.ReactNode;
  /** CSS-module class that defines the hidden → visible transition. */
  className?: string;
  /** Stagger delay in ms, applied to the transition. */
  delay?: number;
}

/**
 * Scroll-reveal wrapper for the landing page. Renders a plain <div> flagged
 * with data-reveal; once it enters the viewport it gets data-visible="true"
 * and the CSS transition (owned by the passed className) runs.
 *
 * Defensive by design: with reduced motion, an old browser without
 * IntersectionObserver, or JS disabled (see the <noscript> override on the
 * page), content is simply shown immediately.
 */
export default function Reveal({ children, className, delay = 0 }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof IntersectionObserver === 'undefined') {
      el.setAttribute('data-visible', 'true');
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.setAttribute('data-visible', 'true');
            observer.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -36px 0px' },
    );

    observer.observe(el);

    // Safety net: a background/hidden tab produces no frames, so IO never
    // fires until the tab is focused. If anything keeps it from firing,
    // content must still become visible — never leave it at opacity 0.
    const fallback = window.setTimeout(() => {
      el.setAttribute('data-visible', 'true');
      observer.disconnect();
    }, 3000);

    return () => {
      window.clearTimeout(fallback);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      data-reveal
      className={className}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
