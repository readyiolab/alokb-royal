// ============================================
// FILE: modules/floor-manager/services/table.service.js
// Business logic for table management
// ============================================

const db = require('../../../config/database');

class TableService {
  /**
   * ✅ CREATE NEW TABLE
   * Creates a new poker table with dealer assignment
   */
  async createTable(data, userId) {
    try {
      const {
        table_number,
        table_name,
        game_type,
        stakes,
        max_seats,
        dealer_id
      } = data;

      // Validate table number is unique
      const existing = await db.select(
        'tbl_tables',
        'table_id',
        'table_number = ? AND table_status = "active"',
        [table_number]
      );

      if (existing) {
        throw new Error(`Table ${table_number} already exists`);
      }

      // Validate dealer if provided
      if (dealer_id) {
        const dealer = await db.select(
          'tbl_dealers',
          'dealer_id, dealer_status',
          'dealer_id = ?',
          [dealer_id]
        );

        if (!dealer) {
          throw new Error('Dealer not found');
        }

        if (dealer.dealer_status !== 'available') {
          throw new Error('Dealer is not available');
        }
      }

      // Create table
      const result = await db.insert('tbl_tables', {
        table_number,
        table_name,
        game_type,
        stakes,
        max_seats,
        dealer_id: dealer_id || null,
        current_occupied_seats: 0,
        table_status: 'active',
        created_by: userId,
        created_at: new Date()
      });

      // If dealer assigned, update dealer status
      if (dealer_id) {
        await this.assignDealerToTable(result.insert_id, dealer_id, userId);
      }

      return {
        table_id: result.insert_id,
        table_number,
        table_name,
        game_type,
        stakes,
        max_seats,
        dealer_assigned: !!dealer_id,
        message: `Table ${table_number} created successfully`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ GET ALL ACTIVE TABLES WITH PLAYERS & DEALER INFO
   * Returns complete table state for floor manager dashboard
   */
  async getAllTables(sessionId) {
    try {
      // Get all active tables with dealer timer info
      const tables = await db.queryAll(
        `SELECT 
          t.*,
          d.dealer_name,
          d.dealer_status,
          ds.shift_status as dealer_shift_status,
          ds.shift_ends_at as dealer_shift_ends_at,
          ds.current_shift_started_at as dealer_shift_started_at,
          ds.shift_duration_minutes as dealer_shift_duration_minutes,
          ds.break_started_at as dealer_break_started_at,
          ds.break_ends_at as dealer_break_ends_at,
          ds.break_duration_minutes as dealer_break_duration_minutes,
          ds.shift_paused_remaining_seconds as dealer_shift_paused_seconds
        FROM tbl_tables t
        LEFT JOIN tbl_dealers d ON t.dealer_id = d.dealer_id
        LEFT JOIN tbl_dealer_shifts ds ON d.dealer_id = ds.dealer_id 
          AND ds.session_id = ? 
          AND ds.shift_status IN ('on_table', 'on_break')
        WHERE t.table_status = 'active'
        ORDER BY CAST(t.table_number AS UNSIGNED)`,
        [sessionId]
      );

      if (!tables || tables.length === 0) {
        return [];
      }

      // Get all players for all tables in one query (performance optimization)
      // ✅ Include all timer-related fields (only columns that exist in DB)
      const allPlayers = await db.queryAll(
        `SELECT 
          tp.*,
          tp.play_timer_status,
          tp.played_time_before_break,
          p.player_name,
          p.phone_number as player_phone,
          bcr.request_id as confirmation_request_id,
          bcr.request_status as confirmation_status
        FROM tbl_table_players tp
        INNER JOIN tbl_players p ON tp.player_id = p.player_id
        LEFT JOIN tbl_buyin_confirmation_requests bcr 
          ON tp.confirmation_request_id = bcr.request_id
        WHERE tp.session_id = ? 
          AND tp.is_removed = FALSE
        ORDER BY tp.table_id, tp.seat_number`,
        [sessionId]
      );

      // Group players by table
      const playersByTable = {};
      allPlayers.forEach(player => {
        if (!playersByTable[player.table_id]) {
          playersByTable[player.table_id] = [];
        }
        playersByTable[player.table_id].push(this.formatPlayerData(player));
      });

      // Combine tables with their players
      const now = new Date();
      const tablesWithPlayers = tables.map(table => {
        const players = playersByTable[table.table_id] || [];
        
        // Calculate empty seats
        const occupiedSeats = players.map(p => p.seat_number);
        const allSeats = Array.from({ length: table.max_seats }, (_, i) => i + 1);
        const emptySeats = allSeats.filter(seat => !occupiedSeats.includes(seat));

        // ✅ Calculate dealer timer info
        let dealerShiftRemainingSeconds = 0;
        let dealerBreakRemainingSeconds = 0;
        let isDealerShiftEnding = false;
        let isDealerShiftOverdue = false;
        
        if (table.dealer_id && table.dealer_shift_ends_at) {
          const shiftEndsAt = new Date(table.dealer_shift_ends_at);
          dealerShiftRemainingSeconds = Math.floor((shiftEndsAt - now) / 1000);
          isDealerShiftEnding = dealerShiftRemainingSeconds > 0 && dealerShiftRemainingSeconds <= 300;
          isDealerShiftOverdue = dealerShiftRemainingSeconds <= 0;
        }
        
        if (table.dealer_break_ends_at) {
          const breakEndsAt = new Date(table.dealer_break_ends_at);
          dealerBreakRemainingSeconds = Math.max(0, Math.floor((breakEndsAt - now) / 1000));
        }

        return {
          table_id: table.table_id,
          table_number: table.table_number,
          table_name: table.table_name,
          game_type: table.game_type,
          stakes: table.stakes,
          max_seats: table.max_seats,
          occupied_seats: table.current_occupied_seats,
          empty_seats: emptySeats,
          table_status: table.table_status,
          
          // ✅ DEALER INFO WITH TIMER FIELDS
          dealer: table.dealer_id ? {
            dealer_id: table.dealer_id,
            dealer_name: table.dealer_name,
            dealer_status: table.dealer_status,
            shift_status: table.dealer_shift_status,
            
            // ✅ Timer fields for frontend countdown
            shift_start_time: table.dealer_shift_started_at,
            shift_duration_minutes: table.dealer_shift_duration_minutes,
            shift_ends_at: table.dealer_shift_ends_at,
            shift_remaining_seconds: dealerShiftRemainingSeconds,
            
            // Break info
            break_started_at: table.dealer_break_started_at,
            break_ends_at: table.dealer_break_ends_at,
            break_duration_minutes: table.dealer_break_duration_minutes,
            break_remaining_seconds: dealerBreakRemainingSeconds,
            
            // Paused state
            shift_paused_remaining_seconds: table.dealer_shift_paused_seconds || 0,
            
            // Alert flags
            is_shift_ending: isDealerShiftEnding,
            is_shift_overdue: isDealerShiftOverdue
          } : null,
          
          players: players,
          
          created_at: table.created_at
        };
      });

      return tablesWithPlayers;
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ FORMAT PLAYER DATA WITH TIME CALCULATIONS
   * Adds real-time play time, call time remaining, etc.
   * 
   * Timer Logic:
   * - PLAYING: Count UP from seated_at (add played_time_before_break if resuming)
   * - ON BREAK: Pause play timer, show break countdown
   * - CALL TIME: Show call time countdown
   */
  formatPlayerData(player) {
    const now = new Date();
    const seatedAt = new Date(player.seated_at);
    const minimumPlayUntil = player.minimum_play_until ? new Date(player.minimum_play_until) : null;
    
    // ✅ CRITICAL: Calculate total played time correctly
    // played_time_before_break stores seconds played before the last break
    const playedBeforeBreakSeconds = parseInt(player.played_time_before_break) || 0;
    
    let totalPlayedSeconds = 0;
    let currentSessionSeconds = 0;
    
    if (player.player_status === 'playing') {
      // Player is actively playing
      // ✅ If player has resumed from break, use last_timer_update as the session start
      // Otherwise use seated_at for initial session
      const sessionStart = player.last_timer_update 
        ? new Date(player.last_timer_update) 
        : seatedAt;
      
      // Current session time = now - session start (resume time or initial seat time)
      currentSessionSeconds = Math.floor((now - sessionStart) / 1000);
      
      // ✅ Total = accumulated (played_time_before_break) + current session
      totalPlayedSeconds = playedBeforeBreakSeconds + currentSessionSeconds;
    } else if (player.player_status === 'on_break') {
      // Player is on break - timer is paused
      // played_time_before_break is the time they played before this break
      totalPlayedSeconds = playedBeforeBreakSeconds;
    } else if (player.player_status === 'call_time_active') {
      // Call time active - use accumulated time
      totalPlayedSeconds = playedBeforeBreakSeconds;
    }
    
    const playedMinutes = Math.floor(totalPlayedSeconds / 60);
    
    // Calculate remaining minimum time
    const remainingMs = minimumPlayUntil ? minimumPlayUntil - now : 0;
    const remainingMinutes = Math.max(0, Math.floor(remainingMs / (1000 * 60)));
    
    // Can player call time?
    const canCallTime = playedMinutes >= (player.minimum_play_time || 120);
    
    // Call time calculations
    let callTimeRemaining = null;
    let callTimeRemainingSeconds = null;
    let mustLeaveIn = null;
    
    if (player.player_status === 'call_time_active' && player.call_time_ends_at) {
      const callTimeEndsAt = new Date(player.call_time_ends_at);
      const callTimeRemainingMs = callTimeEndsAt - now;
      callTimeRemainingSeconds = Math.floor(callTimeRemainingMs / 1000);
      callTimeRemaining = Math.max(0, Math.floor(callTimeRemainingMs / (1000 * 60)));
      
      if (callTimeRemaining === 0) {
        mustLeaveIn = 0;
      }
    }
    
    // Break calculations
    let breakRemaining = null;
    let breakRemainingSeconds = null;
    if (player.player_status === 'on_break' && player.break_ends_at) {
      const breakEndsAt = new Date(player.break_ends_at);
      const breakRemainingMs = breakEndsAt - now;
      breakRemainingSeconds = Math.max(0, Math.floor(breakRemainingMs / 1000));
      breakRemaining = Math.max(0, Math.floor(breakRemainingMs / (1000 * 60)));
    }
    
    return {
      table_player_id: player.table_player_id,
      player_id: player.player_id,
      player_name: player.player_name,
      player_phone: player.player_phone,
      seat_number: player.seat_number,
      buy_in_amount: parseFloat(player.buy_in_amount),
      
      // Status flags
      buy_in_status: player.buy_in_status,
      player_status: player.player_status,
      play_timer_status: player.play_timer_status,
      
      // Confirmation request
      confirmation_request_id: player.confirmation_request_id,
      confirmation_status: player.confirmation_status,
      
      // ✅ TIME TRACKING (for frontend timer hook)
      seated_at: player.seated_at,
      last_timer_update: player.last_timer_update,  // When timer was last updated (resume time)
      
      // ✅ TOTAL PLAYED (accumulated + current session)
      total_played_seconds: totalPlayedSeconds,                      // ✅ For frontend timer
      played_time_before_break: playedBeforeBreakSeconds,            // ✅ For resume calculation
      
      played_minutes: playedMinutes,
      played_hours: Math.floor(playedMinutes / 60),
      played_mins: playedMinutes % 60,
      
      // Minimum play time
      minimum_play_time: player.minimum_play_time,
      minimum_play_until: player.minimum_play_until,
      remaining_minutes: remainingMinutes,
      can_call_time: canCallTime,
      
      // Call time
      call_time_active: player.player_status === 'call_time_active',
      call_time_requested_at: player.call_time_requested_at,
      call_time_duration: player.call_time_duration,
      call_time_ends_at: player.call_time_ends_at,
      call_time_remaining_minutes: callTimeRemaining,
      call_time_remaining_seconds: callTimeRemainingSeconds,
      must_leave_in_minutes: mustLeaveIn,
      
      // Break
      on_break: player.player_status === 'on_break',
      break_started_at: player.break_started_at,
      break_ends_at: player.break_ends_at,
      break_remaining_minutes: breakRemaining,
      break_remaining_seconds: breakRemainingSeconds,
      
      // Flags
      needs_auto_removal: mustLeaveIn === 0,
      overdue: player.buy_in_status === 'AWAITING_CONFIRMATION'
    };
  }


  async addPlayerToTable(data, userId) {
    try {
      const { table_id, player_id, seat_number, buy_in_amount } = data;
      const session = await this.getCurrentSession();
  
      // ✅ Check if seat is free - ONLY check active players
      const seatTaken = await db.select(
        'tbl_table_players',
        '*',
        'table_id = ? AND seat_number = ? AND is_removed = FALSE',
        [table_id, seat_number]
      );
  
      if (seatTaken) {
        throw new Error(`Seat ${seat_number} is already occupied`);
      }
  
      // Insert player with timer fields (only use existing columns)
      const now = new Date();
      const minimumPlayTime = 120; // 120 minutes = 2 hours
      const minimumPlayUntil = new Date(now.getTime() + minimumPlayTime * 60 * 1000);
      
      const result = await db.insert('tbl_table_players', {
        table_id,
        session_id: session.session_id,
        player_id,
        seat_number,
        buy_in_amount,
        buy_in_status: 'AWAITING_CONFIRMATION',
        
        // Timer status
        player_status: 'playing',
        
        // Time tracking - use seated_at as the start time
        seated_at: now,
        
        // Minimum play time
        minimum_play_time: minimumPlayTime,
        minimum_play_until: minimumPlayUntil,
        
        is_removed: false,
        created_by: userId,
        created_at: now
      });
  
      // ✅ Update table occupied seats - FIXED
      const currentTable = await db.select('tbl_tables', 'current_occupied_seats', 'table_id = ?', [table_id]);
      const newOccupiedSeats = (currentTable?.current_occupied_seats || 0) + 1;
      
      await db.update(
        'tbl_tables',
        { current_occupied_seats: newOccupiedSeats },
        'table_id = ?',
        [table_id]
      );
  
      return {
        table_player_id: result.insert_id,
        message: 'Player seated successfully'
      };
    } catch (err) {
      console.error('Error in addPlayerToTable:', err);
      throw err;
    }
  }

  /**
   * ✅ ASSIGN DEALER TO TABLE
   */
  async assignDealerToTable(tableId, dealerId, userId) {
    try {
      const session = await this.getCurrentSession();
      
      // Check if dealer is available
      const dealer = await db.select(
        'tbl_dealers',
        '*',
        'dealer_id = ?',
        [dealerId]
      );
      
      if (!dealer) {
        throw new Error('Dealer not found');
      }
      
      // Check if dealer already assigned to another table
      const currentAssignment = await db.select(
        'tbl_dealer_shifts',
        '*',
        'dealer_id = ? AND session_id = ? AND shift_status = "on_table"',
        [dealerId, session.session_id]
      );
      
      if (currentAssignment) {
        throw new Error('Dealer is already assigned to another table');
      }
      
      // Update table
      await db.update(
        'tbl_tables',
        { dealer_id: dealerId },
        'table_id = ?',
        [tableId]
      );
      
      // Create/Update dealer shift with timer fields
      const shiftDuration = 60; // 60 minutes standard shift
      const now = new Date();
      const shiftEndsAt = new Date(now.getTime() + shiftDuration * 60 * 1000);
      
      await db.insert('tbl_dealer_shifts', {
        session_id: session.session_id,
        dealer_id: dealerId,
        table_id: tableId,
        shift_status: 'on_table',
        
        // ✅ Timer fields for countdown
        shift_timer_status: 'counting',  // ✅ FIX: Should be 'counting' not 'playing'
        shift_start_time: now,
        current_shift_started_at: now,
        shift_duration_minutes: shiftDuration,
        shift_duration_remaining_seconds: shiftDuration * 60,
        shift_ends_at: shiftEndsAt,
        shift_paused_remaining_seconds: 0,  // ✅ NEW: Initialize to 0 when assigned
        
        assigned_by: userId,
        last_timer_update: now
      });
      
      // Update dealer status
      await db.update(
        'tbl_dealers',
        { dealer_status: 'on_table' },
        'dealer_id = ?',
        [dealerId]
      );
      
      return {
        success: true,
        message: `Dealer ${dealer.dealer_name} assigned to table`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ REMOVE DEALER FROM TABLE (Send to break)
   */
  async removeDealerFromTable(tableId, userId) {
    try {
      const table = await db.select('tbl_tables', '*', 'table_id = ?', [tableId]);
      
      if (!table || !table.dealer_id) {
        throw new Error('No dealer assigned to this table');
      }
      
      const session = await this.getCurrentSession();
      
      // Get current shift to calculate remaining time
      const currentShift = await db.select(
        'tbl_dealer_shifts',
        '*',
        'dealer_id = ? AND session_id = ? AND shift_status = "on_table"',
        [table.dealer_id, session.session_id]
      );
      
      // Calculate remaining shift time to resume later
      let shiftPausedRemainingSeconds = 0;
      if (currentShift && currentShift.shift_ends_at) {
        const now = new Date();
        const shiftEndsAt = new Date(currentShift.shift_ends_at);
        shiftPausedRemainingSeconds = Math.max(0, Math.floor((shiftEndsAt - now) / 1000));
      }
      
      // Calculate break end time (15 minutes)
      const breakDuration = 15;
      const breakStartedAt = new Date();
      const breakEndsAt = new Date(breakStartedAt.getTime() + breakDuration * 60 * 1000);
      
      // Update dealer shift to on_break with break countdown
      await db.update(
        'tbl_dealer_shifts',
        {
          shift_status: 'on_break',
          shift_timer_status: 'paused',  // ✅ NEW: Mark timer as paused
          break_started_at: breakStartedAt,
          break_duration_minutes: breakDuration,
          break_ends_at: breakEndsAt,
          shift_paused_remaining_seconds: shiftPausedRemainingSeconds
        },
        'dealer_id = ? AND session_id = ? AND shift_status = "on_table"',
        [table.dealer_id, session.session_id]
      );
      
      // Update dealer status
      await db.update(
        'tbl_dealers',
        { dealer_status: 'on_break' },
        'dealer_id = ?',
        [table.dealer_id]
      );
      
      // Remove dealer from table
      await db.update(
        'tbl_tables',
        { dealer_id: null },
        'table_id = ?',
        [tableId]
      );
      
      return {
        success: true,
        break_ends_at: breakEndsAt,
        message: 'Dealer sent on break'
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ CLOSE TABLE
   */
  async closeTable(tableId, userId) {
    try {
      // Check if table has active players
      const activePlayers = await db.selectAll(
        'tbl_table_players',
        'player_id',
        'table_id = ? AND is_removed = FALSE',
        [tableId]
      );
      
      if (activePlayers && activePlayers.length > 0) {
        throw new Error(`Cannot close table. ${activePlayers.length} players still seated.`);
      }
      
      // Remove dealer if assigned
      const table = await db.select('tbl_tables', 'dealer_id', 'table_id = ?', [tableId]);
      if (table && table.dealer_id) {
        await this.removeDealerFromTable(tableId, userId);
      }
      
      // Close table
      await db.update(
        'tbl_tables',
        { 
          table_status: 'closed',
          updated_at: new Date()
        },
        'table_id = ?',
        [tableId]
      );
      
      return {
        success: true,
        message: 'Table closed successfully'
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ GET CURRENT SESSION
   */
  async getCurrentSession() {
    const today = new Date().toISOString().split('T')[0];
    const session = await db.select(
      'tbl_daily_sessions',
      '*',
      'session_date = ?',
      [today]
    );
    
    if (!session) {
      throw new Error('No active session found for today');
    }
    
    return session;
  }
}

module.exports = new TableService();











