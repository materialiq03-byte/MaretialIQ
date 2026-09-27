'use client';

/**
 * Phase UI-1 — mobile menu button (client island). Toggles the sidebar drawer
 * by flipping a class on the nav element rendered by SidebarNav; keeps state
 * in sync so aria-expanded is truthful.
 */
import { useEffect, useState } from 'react';

export default function HamburgerButton() {
  const [open, setOpen] = useState(false);

  // Reflect external closes (Escape/backdrop/navigation) back into state.
  useEffect(() => {
    const id = window.setInterval(() => {
      setOpen(document.querySelector('.hq-nav-open') !== null);
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  function toggle() {
    const nav = document.querySelector('.hq-nav');
    const willOpen = !nav?.classList.contains('hq-nav-open');
    nav?.classList.toggle('hq-nav-open', willOpen);
    setOpen(willOpen);
  }

  return (
    <button
      type="button"
      className="theme-toggle hq-menu-btn"
      onClick={toggle}
      aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
      aria-expanded={open}
    >
      ☰
    </button>
  );
}
