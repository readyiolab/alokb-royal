-- ============================================
-- Migration: Add Orders Tables
-- For food/drink ordering in floor manager
-- ============================================

-- Orders table
CREATE TABLE IF NOT EXISTS tbl_orders (
    order_id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    table_id INT NULL,
    player_id INT NULL,
    table_player_id INT NULL,
    total_amount DECIMAL(10, 2) DEFAULT 0,
    order_status ENUM('pending', 'preparing', 'ready', 'delivered', 'cancelled') DEFAULT 'pending',
    order_notes TEXT NULL,
    ordered_by INT NOT NULL,
    delivered_at DATETIME NULL,
    cancellation_reason VARCHAR(255) NULL,
    cancelled_by INT NULL,
    cancelled_at DATETIME NULL,
    updated_by INT NULL,
    updated_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (session_id) REFERENCES tbl_daily_sessions(session_id),
    FOREIGN KEY (table_id) REFERENCES tbl_tables(table_id),
    FOREIGN KEY (player_id) REFERENCES tbl_players(player_id),
    
    INDEX idx_session (session_id),
    INDEX idx_table (table_id),
    INDEX idx_player (player_id),
    INDEX idx_status (order_status),
    INDEX idx_created (created_at)
);

-- Order items table
CREATE TABLE IF NOT EXISTS tbl_order_items (
    order_item_id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    item_category ENUM('food', 'drink', 'snack', 'other') DEFAULT 'food',
    quantity INT DEFAULT 1,
    price_per_unit DECIMAL(10, 2) DEFAULT 0,
    total_price DECIMAL(10, 2) DEFAULT 0,
    special_instructions TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (order_id) REFERENCES tbl_orders(order_id) ON DELETE CASCADE,
    
    INDEX idx_order (order_id)
);

-- Add timer fields to tbl_table_players if not exists
ALTER TABLE tbl_table_players
    ADD COLUMN IF NOT EXISTS play_started_at DATETIME NULL AFTER seated_at,
    ADD COLUMN IF NOT EXISTS total_played_seconds INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_break_seconds INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS played_time_before_break INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_session_seconds INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS effective_play_seconds INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS play_timer_status ENUM('counting', 'paused', 'call_time', 'completed') DEFAULT 'counting',
    ADD COLUMN IF NOT EXISTS break_count INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS break_duration INT NULL,
    ADD COLUMN IF NOT EXISTS call_time_requested_at DATETIME NULL,
    ADD COLUMN IF NOT EXISTS call_time_duration INT NULL,
    ADD COLUMN IF NOT EXISTS call_time_ends_at DATETIME NULL,
    ADD COLUMN IF NOT EXISTS must_leave_at DATETIME NULL;

-- Add stats fields to tbl_players if not exists
ALTER TABLE tbl_players
    ADD COLUMN IF NOT EXISTS total_play_time_seconds INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_sessions INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_break_time_seconds INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avg_session_seconds INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_session_at DATETIME NULL;

-- Player time log table for tracking events
CREATE TABLE IF NOT EXISTS tbl_player_time_log (
    log_id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    table_player_id INT NOT NULL,
    player_id INT NOT NULL,
    event_type ENUM('seated', 'break_started', 'break_resumed', 'call_time_started', 'call_time_extended', 'removed') NOT NULL,
    event_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    event_data JSON NULL,
    notes TEXT NULL,
    performed_by INT NULL,
    
    INDEX idx_session (session_id),
    INDEX idx_table_player (table_player_id),
    INDEX idx_player (player_id),
    INDEX idx_event_type (event_type)
);

