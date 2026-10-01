-- 004_persist_color_slot.up.sql
-- Add color_slot as a persisted column (assigned once at invite time, never recomputed)
-- This fixes the ROW_NUMBER() bug where removing a middle member shifts all subsequent slots.

ALTER TABLE workspace_members ADD COLUMN color_slot INTEGER NOT NULL DEFAULT 0;

-- Backfill existing members: assign slots by join order (one-time, then never recomputed)
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY joined_at ASC) - 1 AS slot
  FROM workspace_members
)
UPDATE workspace_members SET color_slot = ranked.slot
FROM ranked WHERE workspace_members.id = ranked.id;
