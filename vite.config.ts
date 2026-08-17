import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createClient } from '@supabase/supabase-js';
import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

const env = { ...process.env };
try { const r = dotenv.config(); if (r.parsed) Object.assign(env, r.parsed); } catch {}
const SUPABASE_URL = env.VITE_SUPABASE_URL ?? '';
const SERVICE_KEY  = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
// On-prem mail relay. Defaults to the local Supabase mail catcher (Mailpit),
// whose SMTP port is exposed by supabase/config.toml [local_smtp] smtp_port.
// Point SMTP_HOST/SMTP_PORT at the customer's relay for a real deployment.
const SMTP_HOST = env.SMTP_HOST ?? '127.0.0.1';
const SMTP_PORT = parseInt(env.SMTP_PORT ?? '54325', 10);
const MAIL_FROM = env.MAIL_FROM ?? 'Secure Gate VMS <no-reply@securegate.local>';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const ORT_DIR = join(ROOT, 'public', 'ort');

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Dev-only: onnxruntime-web loads its WASM runtime via a runtime dynamic
// import() of /ort/ort-wasm-*.mjs. Vite's import-analysis rewrites that fetch
// to a ?import request, and the transform middleware then refuses public-dir
// files ("should not be imported from source code"), which surfaces as
// "Failed to fetch dynamically imported module" and "no available backend
// found". This middleware runs before Vite's transform middleware and serves
// the files straight off disk with the correct MIME type.
function ortAssetsMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url ?? '';
  const pathOnly = url.split('?')[0];
  if (!pathOnly.startsWith('/ort/')) { next(); return; }
  const fileName = pathOnly.slice('/ort/'.length);
  if (fileName.includes('/') || fileName.includes('..') || !existsSync(join(ORT_DIR, fileName))) {
    next();
    return;
  }
  res.setHeader('Content-Type', fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  res.end(readFileSync(join(ORT_DIR, fileName)));
}

// Dev-only plugin — bypasses RLS recursion via service_role key.
function apiProxyPlugin(): ReturnType<typeof react> {
  return {
    name: 'api-proxy',
    configureServer(server) {
      server.middlewares.use(ortAssetsMiddleware);
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        try {
          const url = req.url ?? '';
          if (!SUPABASE_URL || !SERVICE_KEY) {
            console.error('[api-proxy] Missing env SUPABASE_URL or SERVICE_KEY');
            if (url.startsWith('/api/')) { res.writeHead(500).end('Proxy not configured'); return; }
            next(); return;
          }

          // Only touch /api/* requests. Setting Content-Type here for every
          // response would make Vite serve static modules (e.g. the ORT wasm
          // loader in public/ort/) as application/json, and browsers reject
          // those for ES module imports.
          if (!url.startsWith('/api/')) { next(); return; }

          const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
            auth: { autoRefreshToken: false, persistSession: false },
          });
          res.setHeader('Content-Type', 'application/json');

          // GET /api/hosts/:deptId — list profiles by department
          const hostsMatch = url.match(/^\/api\/hosts\/(.+)$/);
          if (hostsMatch) {
            const { data, error } = await admin.from('profiles').select('id, full_name, email, role').eq('department_id', hostsMatch[1]!).order('full_name');
            if (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); return; }
            res.end(JSON.stringify(data ?? []));
            return;
          }

          // ── User (employee / guard) management — service-role only ──────────
          // On-prem admin panel calls these to add / list / remove login users
          // of any role. Runs server-side so the service key never reaches the
          // browser bundle. In a built deployment this same logic moves to the
          // customer's small admin server; the contract stays identical.
          const usersColl = url.split('?')[0] === '/api/users';
          const userItem = url.split('?')[0]?.match(/^\/api\/users\/([a-f0-9-]+)$/);

          if (usersColl && req.method === 'GET') {
            const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
            if (listErr) { res.writeHead(500).end(JSON.stringify({ error: listErr.message })); return; }
            const { data: profiles } = await admin.from('profiles').select('id, full_name, role, department_id');
            const { data: depts } = await admin.from('departments').select('id, name');
            const deptName = new Map((depts ?? []).map((d: any) => [d.id, d.name]));
            const byId = new Map((profiles ?? []).map((p: any) => [p.id, p]));
            const rows = (list?.users ?? []).map((u) => {
              const p: any = byId.get(u.id) ?? {};
              return {
                id: u.id, email: u.email, full_name: p.full_name ?? '',
                role: p.role ?? 'staff', department_id: p.department_id ?? null,
                department_name: p.department_id ? (deptName.get(p.department_id) ?? null) : null,
                created_at: u.created_at,
              };
            }).sort((a, b) => (a.full_name || a.email || '').localeCompare(b.full_name || b.email || ''));
            res.end(JSON.stringify(rows));
            return;
          }

          if (usersColl && req.method === 'POST') {
            const body = await readJsonBody(req);
            const { email, password, full_name, role, department_id } = body ?? {};
            const ALLOWED = ['guard', 'hod', 'staff', 'admin', 'ceo'];
            if (!email || !password || !full_name || !ALLOWED.includes(role)) {
              res.writeHead(400).end(JSON.stringify({ error: 'email, password, full_name and a valid role are required' })); return;
            }
            const { data: created, error: cErr } = await admin.auth.admin.createUser({
              email, password, email_confirm: true, user_metadata: { full_name },
            });
            if (cErr) { res.writeHead(400).end(JSON.stringify({ error: cErr.message })); return; }
            const uid = created.user!.id;
            const { error: pErr } = await admin.from('profiles').update({
              full_name, role, department_id: department_id || null,
            }).eq('id', uid);
            if (pErr) { res.writeHead(500).end(JSON.stringify({ error: pErr.message })); return; }
            res.end(JSON.stringify({ id: uid, email, full_name, role, department_id: department_id || null }));
            return;
          }

          if (userItem && req.method === 'PATCH') {
            const body = await readJsonBody(req);
            const patch: Record<string, unknown> = {};
            if (typeof body.full_name === 'string') patch.full_name = body.full_name;
            if (typeof body.role === 'string') patch.role = body.role;
            if ('department_id' in body) patch.department_id = body.department_id || null;
            const { error } = await admin.from('profiles').update(patch).eq('id', userItem[1]!);
            if (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); return; }
            res.end(JSON.stringify({ success: true }));
            return;
          }

          if (userItem && req.method === 'DELETE') {
            const { error } = await admin.auth.admin.deleteUser(userItem[1]!);
            if (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); return; }
            res.end(JSON.stringify({ success: true }));
            return;
          }

          // POST /api/send-email — OTP / notification dispatch via on-prem SMTP.
          if (url.split('?')[0] === '/api/send-email' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const { to, subject, text, html } = body ?? {};
            if (!to || !subject || (!text && !html)) {
              res.writeHead(400).end(JSON.stringify({ error: 'to, subject and text/html are required' })); return;
            }
            try {
              const transport = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: false, tls: { rejectUnauthorized: false } });
              await transport.sendMail({ from: MAIL_FROM, to, subject, text, html });
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              // Email is a best-effort channel; the OTP is also shown on screen
              // and logged in otp_deliveries, so a mail failure must not 500 the
              // caller's flow. Report it so the UI can note "not delivered".
              res.writeHead(200).end(JSON.stringify({ success: false, error: e instanceof Error ? e.message : 'send failed' }));
            }
            return;
          }

          // GET /api/departments — list departments (for admin user manager)
          if (url.split('?')[0] === '/api/departments' && req.method === 'GET') {
            const { data, error } = await admin.from('departments').select('id, name, code').order('name');
            if (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); return; }
            res.end(JSON.stringify(data ?? []));
            return;
          }

          // POST /api/departments — create department (bypasses RLS recursion)
          if (url === '/api/departments' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', async () => {
              try {
                const { name, code } = JSON.parse(body);
                if (!name || !code) { res.writeHead(400).end(JSON.stringify({ error: 'name and code required' })); return; }
                const { data, error } = await admin.from('departments').insert({ name, code }).select().single();
                if (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); return; }
                res.end(JSON.stringify(data));
              } catch (e) {
                res.writeHead(500).end(JSON.stringify({ error: e instanceof Error ? e.message : 'Bad request' }));
              }
            });
            return;
          }

          // PUT /api/departments/:id — update department
          const deptPutMatch = url.match(/^\/api\/departments\/([a-f0-9-]+)$/);
          if (deptPutMatch && req.method === 'PUT') {
            const id = deptPutMatch[1]!;
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', async () => {
              try {
                const { name, code } = JSON.parse(body);
                if (!name || !code) { res.writeHead(400).end(JSON.stringify({ error: 'name and code required' })); return; }
                const { data, error } = await admin.from('departments').update({ name, code }).eq('id', id).select().single();
                if (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); return; }
                res.end(JSON.stringify(data));
              } catch (e) {
                res.writeHead(500).end(JSON.stringify({ error: e instanceof Error ? e.message : 'Bad request' }));
              }
            });
            return;
          }

          // DELETE /api/departments/:id — delete department (with FK safety)
          const deptDeleteMatch = url.match(/^\/api\/departments\/([a-f0-9-]+)$/);
          if (deptDeleteMatch && req.method === 'DELETE') {
            const id = deptDeleteMatch[1]!;
            try {
              // First, unlink profiles that reference this department
              await admin.from('profiles').update({ department_id: null, role: 'staff' }).eq('department_id', id);
              const { error } = await admin.from('departments').delete().eq('id', id);
              if (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); return; }
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.writeHead(500).end(JSON.stringify({ error: e instanceof Error ? e.message : 'Failed to delete department' }));
            }
            return;
          }

          next();
        } catch (e) {
          console.error('[api-proxy] Error:', e);
          res.writeHead(500).end('Internal error');
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiProxyPlugin()],
  server: {
    port: parseInt(env.PORT || '5173', 10),
    allowedHosts: ['5173-itgbyrum77hhmtwn4sujd-a6830051.sg1.manus.computer'],
  },
});
