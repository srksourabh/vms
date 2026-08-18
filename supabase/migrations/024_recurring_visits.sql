-- Migration 024: Recurring visit series (M24-RECURRING / FR-WF-01)
-- Supports scheduled recurring visitors (weekly maintenance, monthly auditors).

CREATE TABLE IF NOT EXISTS recurring_visits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id   uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  host_id         uuid NOT NULL REFERENCES profiles(id),
  created_by      uuid NOT NULL REFERENCES profiles(id),

  -- Visitor identity (pre-registered)
  visitor_name    text NOT NULL,
  visitor_phone   text NOT NULL,
  visitor_company text,
  purpose         text NOT NULL DEFAULT 'maintenance',

  -- Recurrence pattern
  recurrence_type text NOT NULL CHECK (recurrence_type IN ('daily', 'weekly', 'monthly')),
  recurrence_day  integer,          -- 0=Sunday...6=Saturday for weekly; 1-31 for monthly
  start_date      date NOT NULL,
  end_date        date,             -- null = no end

  -- State
  is_active       boolean NOT NULL DEFAULT true,
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE recurring_visits ENABLE ROW LEVEL SECURITY;

-- HOD can see their department's recurring visits
drop policy if exists "hod_select_recurring" on recurring_visits;
CREATE POLICY "hod_select_recurring" ON recurring_visits
  FOR SELECT USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('hod', 'admin', 'super_admin')
    AND (
      (auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin', 'super_admin')
      OR department_id::text = (auth.jwt() -> 'app_metadata' ->> 'department_id')
    )
  );

-- Only HOD of the department or admin can insert
drop policy if exists "hod_insert_recurring" on recurring_visits;
CREATE POLICY "hod_insert_recurring" ON recurring_visits
  FOR INSERT WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('hod', 'admin', 'super_admin')
    AND (
      (auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin', 'super_admin')
      OR department_id::text = (auth.jwt() -> 'app_metadata' ->> 'department_id')
    )
  );

-- HOD can update/deactivate their series
drop policy if exists "hod_update_recurring" on recurring_visits;
CREATE POLICY "hod_update_recurring" ON recurring_visits
  FOR UPDATE USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('hod', 'admin', 'super_admin')
    AND (
      (auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin', 'super_admin')
      OR department_id::text = (auth.jwt() -> 'app_metadata' ->> 'department_id')
    )
  );

COMMENT ON TABLE recurring_visits IS 'Recurring visitor series — generates visits on a schedule.';
