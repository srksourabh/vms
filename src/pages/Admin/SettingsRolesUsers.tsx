import React from 'react';
import { Link } from 'react-router-dom';
import DepartmentsManager from './DepartmentsManager';
import UserManager from './UserManager';

// The Roles & Users section: departments, their heads of department, HOD
// password resets and the activity log.
//
// THIS IS THE OLD ADMIN PANEL, MOVED RATHER THAN REBUILT (client instruction,
// 2026-08-17: keep the current user settings and integrate them into the new
// tabs). `/admin` was a page of its own until today; the new nav has no room
// for it beside nine tabs, and user administration is what a Settings screen's
// Roles & Users section is for. `DepartmentsManager` is rendered unchanged —
// it owns the create/edit/delete flows, the confirm dialogs and the HOD invite
// path (`addHod` promotes an existing profile by email or invites a new
// account, and writing `profiles.role` is enough because migration 010's
// trigger mirrors it into the JWT). Redrawing working CRUD to fit a new frame
// would put the one part of this screen that already worked at risk for a
// change of margin.
//
// What did NOT come across is `AdminPanel.tsx`'s page header — the gear plate,
// the "Administration" eyebrow and the "Admin Panel" title. The Settings page
// above it already carries a title, and the sidebar item says it too; three
// statements of one name on one screen is the rule this project applies to
// every other board.

export default function SettingsRolesUsers(): React.ReactElement {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-navy-500 max-w-xl">
          Departments and the heads of department who approve their visitors. A head of
          department is added by name and email — an existing account is promoted, a new
          one is invited.
        </p>
        <Link
          to="/admin/activity"
          className="glass-chip text-navy-600 hover:text-brand-600 hover:border-brand-500/30 transition-all shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Activity Log
        </Link>
      </div>

      <UserManager />

      <DepartmentsManager />
    </div>
  );
}
