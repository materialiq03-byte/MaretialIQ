import { requireUser } from '@/lib/auth/guard';

export const dynamic = 'force-dynamic';

export default async function ForbiddenPage() {
  await requireUser();
  return (
    <main>
      <h1>403 — Access Restricted</h1>
      <div className="empty-state">
        <p>You do not have permission to access this resource.</p>
        <p className="evidence-detail">
          If you believe you should have access, contact your platform administrator. Internal authorization
          details are not disclosed.
        </p>
        <p>
          <a className="btn" href="/">Return to Dashboard</a>
        </p>
      </div>
    </main>
  );
}
