// Admin employee / guard management.
//
// Creating a login-capable user needs the service role (Supabase Admin API),
// which must never reach the browser bundle. These calls go to the on-prem
// admin endpoint (`/api/users`) served by the dev/admin proxy in vite.config.ts
// using SUPABASE_SERVICE_ROLE_KEY server-side. In a built on-prem deployment
// the same endpoints are provided by the customer's small admin server; the
// request/response contract here is what stays stable.
import type { UserRole } from '../types/index';

export type ManagedUser = {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  department_id: string | null;
  department_name: string | null;
  created_at?: string;
};

export type NewUserInput = {
  email: string;
  password: string;
  full_name: string;
  role: UserRole;
  department_id?: string | null;
};

async function parse(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export type DeptOption = { id: string; name: string; code?: string };

export async function listDepartments(): Promise<DeptOption[]> {
  return parse(await fetch('/api/departments'));
}

export async function listUsers(): Promise<ManagedUser[]> {
  return parse(await fetch('/api/users'));
}

export async function createUser(input: NewUserInput): Promise<ManagedUser> {
  return parse(await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function updateUser(
  id: string,
  patch: Partial<Pick<ManagedUser, 'full_name' | 'role' | 'department_id'>>,
): Promise<void> {
  await parse(await fetch(`/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }));
}

export async function deleteUser(id: string): Promise<void> {
  await parse(await fetch(`/api/users/${id}`, { method: 'DELETE' }));
}

export const ROLE_LABELS: Record<UserRole, string> = {
  guard: 'Security Guard',
  staff: 'Employee',
  hod: 'Head of Dept (approver)',
  admin: 'Administrator',
  ceo: 'CEO',
};
