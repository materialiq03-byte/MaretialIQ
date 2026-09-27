/**
 * Phase UI-1 — no-flash theme bootstrap. Rendered as an inline <script> in
 * <head> BEFORE first paint: reads the persisted preference (or system
 * preference when unset) and sets html[data-theme]. Server components never
 * need to know the theme; the toggle island only flips the attribute + storage.
 */
export const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem('materialiq-theme');var t=s==='dark'||s==='light'?s:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
