import React, { useCallback, useEffect, useState } from 'react';
import { listUsers, createUser, deleteUser, listDepartments, ROLE_LABELS, type ManagedUser, type NewUserInput, type DeptOption } from '../../lib/adminUsers';
import type { UserRole } from '../../types/index';

// Admin control over WHO can log in: employees (staff), security guards, HODs
// and admins. Uses the service-role /api/users endpoint (see lib/adminUsers.ts).
const CREATABLE_ROLES: UserRole[] = ['staff', 'guard', 'hod', 'admin'];
const DEPT_ROLES: UserRole[] = ['staff', 'hod'];

const ROLE_PILL: Record<UserRole, string> = {
  guard: 'bg-blue-100 text-blue-700',
  staff: 'bg-emerald-100 text-emerald-700',
  hod: 'bg-violet-100 text-violet-700',
  admin: 'bg-amber-100 text-amber-700',
  ceo: 'bg-rose-100 text-rose-700',
};

const EMPTY: NewUserInput = { email: '', password: '', full_name: '', role: 'staff', department_id: '' };

export default function UserManager(): React.ReactElement {
  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<NewUserInput>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, d] = await Promise.all([listUsers(), listDepartments()]);
      setUsers(u); setDepartments(d); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load users'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const set = <K extends keyof NewUserInput>(k: K, v: NewUserInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setNotice('');
    if (!form.full_name.trim() || !form.email.trim() || !form.password.trim()) {
      setError('Name, email and a temporary password are required.'); return;
    }
    if (DEPT_ROLES.includes(form.role) && !form.department_id) {
      setError('Employees and HODs must be assigned to a department.'); return;
    }
    setBusy(true);
    try {
      await createUser({ ...form, email: form.email.trim(), full_name: form.full_name.trim(), department_id: form.department_id || null });
      setNotice(`${ROLE_LABELS[form.role]} "${form.full_name.trim()}" created. They can now log in with the email and temporary password.`);
      setForm(EMPTY);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create the user.'); }
    finally { setBusy(false); }
  };

  const remove = async (u: ManagedUser) => {
    if (!window.confirm(`Remove ${u.full_name || u.email}? They will no longer be able to log in.`)) return;
    setError(''); setNotice('');
    try { await deleteUser(u.id); setNotice(`Removed ${u.full_name || u.email}.`); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove the user.'); }
  };

  return (
    <div className="card-premium p-6 space-y-5">
      <div>
        <h3 className="text-base font-bold text-navy-950 dark:text-white">Employees &amp; Security Guards</h3>
        <p className="text-sm text-navy-500 dark:text-navy-400 mt-0.5">
          Add or remove any user who can log in — employees who pre-register visitors, and the security guards at the gate.
        </p>
      </div>

      <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-3 rounded-xl border border-surface-200 dark:border-navy-700 p-4">
        <div><label className="label">Name *</label><input className="input" value={form.full_name} onChange={(e) => set('full_name', e.target.value)} /></div>
        <div><label className="label">Email (login) *</label><input type="email" className="input" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="person@company.com" /></div>
        <div><label className="label">Temporary Password *</label><input className="input" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="e.g. Welcome@123" /></div>
        <div>
          <label className="label">Role *</label>
          <select className="input" value={form.role} onChange={(e) => set('role', e.target.value as UserRole)}>
            {CREATABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Department {DEPT_ROLES.includes(form.role) ? '*' : '(optional)'}</label>
          <select className="input" value={form.department_id ?? ''} onChange={(e) => set('department_id', e.target.value)}>
            <option value="">{DEPT_ROLES.includes(form.role) ? 'Select department' : 'None'}</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="flex items-end">
          <button type="submit" disabled={busy} className="btn-primary w-full">{busy ? 'Adding…' : 'Add User'}</button>
        </div>
      </form>

      {error && <div className="alert-error">{error}</div>}
      {notice && <div className="alert-success">{notice}</div>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-navy-500 dark:text-navy-400 border-b border-surface-200 dark:border-navy-700">
              <th className="py-2 pr-3 font-semibold">Name</th>
              <th className="py-2 pr-3 font-semibold">Email</th>
              <th className="py-2 pr-3 font-semibold">Role</th>
              <th className="py-2 pr-3 font-semibold">Department</th>
              <th className="py-2 pr-3 font-semibold text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="py-6 text-center text-navy-400">Loading users…</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={5} className="py-6 text-center text-navy-400">No users yet.</td></tr>
            ) : users.map((u) => (
              <tr key={u.id} className="border-b border-surface-100 dark:border-navy-800">
                <td className="py-2 pr-3 font-medium text-navy-900 dark:text-white">{u.full_name || '—'}</td>
                <td className="py-2 pr-3 text-navy-600 dark:text-navy-300">{u.email}</td>
                <td className="py-2 pr-3">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${ROLE_PILL[u.role] ?? 'bg-surface-200 text-navy-700'}`}>
                    {ROLE_LABELS[u.role] ?? u.role}
                  </span>
                </td>
                <td className="py-2 pr-3 text-navy-600 dark:text-navy-300">{u.department_name ?? '—'}</td>
                <td className="py-2 pr-3 text-right">
                  <button onClick={() => remove(u)} className="text-danger-600 hover:text-danger-700 text-xs font-semibold">Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
