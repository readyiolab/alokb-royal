-- ============================================
-- MIGRATION: Add Player Time Tracking Columns
-- Created: 2025-12-25
-- Purpose: Add columns to track player time on table
-- ============================================

-- Add total_time_played_minutes if not exists
ALTER TABLE tbl_table_players 
ADD COLUMN IF NOT EXISTS total_time_played_minutes INT DEFAULT 0 COMMENT 'Total minutes played in this session';

-- Add total_break_minutes if not exists  
ALTER TABLE tbl_table_players 
ADD COLUMN IF NOT EXISTS total_break_minutes INT DEFAULT 0 COMMENT 'Total minutes on break';

-- Ensure played_time_before_break exists
ALTER TABLE tbl_table_players 
ADD COLUMN IF NOT EXISTS played_time_before_break INT DEFAULT 0 COMMENT 'Seconds played before current break';

-- Ensure play_timer_status exists
ALTER TABLE tbl_table_players 
ADD COLUMN IF NOT EXISTS play_timer_status VARCHAR(20) DEFAULT 'counting' COMMENT 'counting, paused, call_time, completed';

-- ============================================
-- Add columns to tbl_players for lifetime stats
-- ============================================

-- Total hours played (lifetime)
ALTER TABLE tbl_players 
ADD COLUMN IF NOT EXISTS total_hours_played DECIMAL(10,2) DEFAULT 0 COMMENT 'Total hours played (lifetime)';

-- Total sessions
ALTER TABLE tbl_players 
ADD COLUMN IF NOT EXISTS total_sessions INT DEFAULT 0 COMMENT 'Total number of sessions played';

-- Average session duration in minutes
ALTER TABLE tbl_players 
ADD COLUMN IF NOT EXISTS avg_session_minutes INT DEFAULT 0 COMMENT 'Average session duration in minutes';

-- Last session date
ALTER TABLE tbl_players 
ADD COLUMN IF NOT EXISTS last_session_at DATETIME NULL COMMENT 'Last time player played';

-- ============================================
-- VERIFICATION QUERIES
-- ============================================

-- Check tbl_table_players columns
-- DESCRIBE tbl_table_players;

-- Check tbl_players columns
-- DESCRIBE tbl_players;

