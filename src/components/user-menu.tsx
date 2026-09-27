'use client';

import { useState, useRef, useEffect } from 'react';
import { ROLE_LABELS, type SessionUser } from '@/lib/auth/types';

export default function UserMenu({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const roleLabel = ROLE_LABELS[user.role];
  const orgLabel = user.organizationCode ?? 'All organizations';

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-avatar" aria-hidden="true">
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="user-meta">
          <span className="user-name">{user.name}</span>
          <span className="user-org">{orgLabel}</span>
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="user-menu-panel" role="menu">
          <div className="user-menu-head">
            <div>{user.name}</div>
            <div className="evidence-detail">{roleLabel}</div>
            <div className="evidence-detail">{user.email}</div>
            {user.demoSwitched ? <span className="badge pending">DEMO SESSION</span> : null}
          </div>
          <a role="menuitem" href="/settings" onClick={() => setOpen(false)}>
            Settings
          </a>
          {user.role === 'platform_admin' ? (
            <a role="menuitem" href="/admin" onClick={() => setOpen(false)}>
              Administration
            </a>
          ) : null}
          <form action="/logout" method="post">
            <button type="submit" role="menuitem" className="user-menu-logout">
              Logout
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
