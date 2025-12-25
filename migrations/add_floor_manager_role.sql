-- Migration: Add floor_manager role to tbl_users
-- Run this migration to enable floor manager role

-- Step 1: Alter the role enum to include floor_manager
ALTER TABLE tbl_users 
MODIFY COLUMN role ENUM('admin', 'cashier', 'floor_manager', 'player') DEFAULT 'player';

-- Step 2: Add unique constraint on username if not exists
-- ALTER TABLE tbl_users ADD UNIQUE INDEX idx_username (username);

-- Verification query
-- SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbl_users' AND COLUMN_NAME = 'role';

