-- ============================================
-- CLEANUP MIGRATION: Remove Redundant Columns
-- Created: 2025-12-25
-- Purpose: Clean up duplicate/unused columns
-- ============================================

-- ============================================
-- tbl_table_players - Remove redundant columns
-- ============================================

-- Keep these ESSENTIAL columns:
-- table_player_id, session_id, table_id, player_id, seat_number
-- buy_in_amount, buy_in_status, confirmation_request_id
-- player_status, play_timer_status
-- seated_at, played_time_before_break, total_played_seconds, total_break_seconds
-- minimum_play_time, minimum_play_until
-- break_started_at, break_duration, break_ends_at, break_count
-- call_time_requested_at, call_time_duration, call_time_ends_at, must_leave_at
-- is_removed, removed_at, removed_by, created_by, created_at, updated_at

-- Remove REDUNDANT columns (these duplicate functionality):
-- play_start_time (use seated_at instead - they're the same when player first sits)
-- play_paused_time (use break_started_at instead)
-- play_paused_remaining_seconds (can be calculated)
-- play_duration_remaining_seconds (can be calculated from minimum_play_until)
-- break_start_time (duplicate of break_started_at)
-- break_paused_remaining_seconds (break ends_at is enough)
-- call_time_start_time (duplicate of call_time_requested_at)
-- call_time_paused_remaining_seconds (call_time_ends_at is enough)
-- total_time_played_minutes (use total_played_seconds instead)
-- last_timer_update (not needed)

-- ⚠️ RUN THESE ONE BY ONE and check for errors
-- First, verify columns exist before dropping:

-- Check if columns exist and drop them
SET @table_name = 'tbl_table_players';

-- Drop redundant columns (only if they exist)
ALTER TABLE tbl_table_players 
    DROP COLUMN IF EXISTS play_start_time,
    DROP COLUMN IF EXISTS play_paused_time,
    DROP COLUMN IF EXISTS play_paused_remaining_seconds,
    DROP COLUMN IF EXISTS play_duration_remaining_seconds,
    DROP COLUMN IF EXISTS break_start_time,
    DROP COLUMN IF EXISTS break_paused_remaining_seconds,
    DROP COLUMN IF EXISTS call_time_start_time,
    DROP COLUMN IF EXISTS call_time_paused_remaining_seconds,
    DROP COLUMN IF EXISTS total_time_played_minutes,
    DROP COLUMN IF EXISTS last_timer_update,
    DROP COLUMN IF EXISTS total_session_seconds,
    DROP COLUMN IF EXISTS effective_play_seconds;

-- Ensure essential columns exist with correct types
ALTER TABLE tbl_table_players
    MODIFY COLUMN player_status ENUM('playing', 'on_break', 'call_time_active', 'removed') DEFAULT 'playing',
    MODIFY COLUMN play_timer_status ENUM('counting', 'paused', 'call_time', 'completed') DEFAULT 'counting';

-- Add missing essential columns if they don't exist
ALTER TABLE tbl_table_players
    ADD COLUMN IF NOT EXISTS total_played_seconds INT DEFAULT 0 AFTER seated_at,
    ADD COLUMN IF NOT EXISTS total_break_seconds INT DEFAULT 0 AFTER total_played_seconds,
    ADD COLUMN IF NOT EXISTS played_time_before_break INT DEFAULT 0 AFTER total_break_seconds,
    ADD COLUMN IF NOT EXISTS break_count INT DEFAULT 0 AFTER break_ends_at;

-- ============================================
-- tbl_players - Clean up redundant columns
-- ============================================

-- Keep these ESSENTIAL columns:
-- player_id, player_code, player_name, phone_number, email, address
-- player_type, kyc_status, kyc_completed_at
-- credit_limit, credit_limit_personal, credit_limit_set_by, credit_limit_set_at
-- total_buy_ins, total_cash_outs, total_credits_issued, total_credits_settled, outstanding_credit
-- last_visit_date, visit_count, notes
-- is_active, is_blacklisted, blacklist_reason
-- created_by, created_at, updated_at
-- total_rakeback_received, stored_chips

-- Stats columns for CRM (keep these):
-- total_play_time_seconds, total_sessions, total_break_time_seconds
-- avg_session_seconds, last_session_at

-- No columns to remove from tbl_players - all are needed

-- ============================================
-- tbl_player_time_log - This is a log table, keep as is
-- ============================================

-- Structure is good:
-- log_id, session_id, table_player_id, player_id
-- event_type, event_time, notes, performed_by

-- Add event_data column if not exists for storing JSON metadata
ALTER TABLE tbl_player_time_log
    ADD COLUMN IF NOT EXISTS event_data JSON NULL AFTER event_type;

-- ============================================
-- VERIFY FINAL STRUCTURE
-- ============================================

-- Run these to verify:
-- DESCRIBE tbl_table_players;
-- DESCRIBE tbl_players;
-- DESCRIBE tbl_player_time_log;

