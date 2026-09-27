'use client';

/**
 * Phase UI-1 — theme switch (client island). Flips html[data-theme] and
 * persists the choice. Restrained icon button for the top bar; accessible
 * name + state via aria-label/aria-pressed. Initial render shows the sun/moon
 * glyph that matches the bootstrap-applied theme (settled on mount).
 */
import { useEffect, useState } from 'react';

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'dark' : 'light');
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('materialiq-theme', next);
    } catch {
      /* storage unavailable — theme applies for the session only */
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={theme === 'dark'}
      title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
