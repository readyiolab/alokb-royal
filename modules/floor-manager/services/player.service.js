// ============================================
// FILE: modules/floor-manager/services/player.service.js
// Business logic for player management with timing
// 
// UPDATED: Call time changed from 5 minutes to 60 minutes
// ============================================

const db = require('../../../config/database');
const tableService = require('./table.service');

class PlayerService {
  /**
   * ✅ ADD PLAYER TO TABLE
   * Timer status: 'playing' - countdown from 120 minutes
   */
  async addPlayerToTable(data, userId) {
    try {
      const {
        table_id,
        player_id,
        seat_number,
        buy_in_amount
      } = data;
  
      const session = await tableService.getCurrentSession();
  
      // Validate table exists and has space
      const table = await db.select(
        'tbl_tables',
        '*',
        'table_id = ? AND table_status = "active"',
        [table_id]
      );
  
      if (!table) {
        throw new Error('Table not found or inactive');
      }
  
      // ✅ FIX: Check ACTUAL player count, not the counter (which can get out of sync)
      const actualPlayerCount = await db.query(
        `SELECT COUNT(*) as count FROM tbl_table_players 
         WHERE table_id = ? AND is_removed = FALSE`,
        [table_id]
      );

      if (actualPlayerCount && actualPlayerCount.count >= table.max_seats) {
        throw new Error('Table is full');
      }
  
      // Check if seat is occupied
      const seatOccupied = await db.select(
        'tbl_table_players',
        'table_player_id',
        'table_id = ? AND seat_number = ? AND is_removed = FALSE',
        [table_id, seat_number]
      );
  
      if (seatOccupied) {
        throw new Error(`Seat ${seat_number} is already occupied`);
      }
  
      // Get player
      const player = await db.select(
        'tbl_players',
        '*',
        'player_id = ?',
        [player_id]
      );
  
      if (!player) {
        throw new Error('Player not found');
      }
  
      // Calculate minimum play until time (2 hours)
      const seatedAt = new Date();
      const minimumPlayTime = 120; // 120 minutes = 2 hours
      const minimumPlayUntil = new Date(seatedAt.getTime() + minimumPlayTime * 60 * 1000);
  
      // Create buy-in confirmation request
      const requestResult = await db.insert('tbl_buyin_confirmation_requests', {
        session_id: session.session_id,
        table_id,
        player_id: player.player_id,
        seat_number,
        buy_in_amount,
        collected_by: userId,
        request_status: 'pending',
        created_at: new Date()
      });
  
      const requestId = requestResult.insert_id;
  
      // ✅ SEAT PLAYER WITH TIMER FIELDS
      const playerResult = await db.insert('tbl_table_players', {
        session_id: session.session_id,
        table_id,
        player_id: player.player_id,
        seat_number,
        buy_in_amount,
        buy_in_status: 'AWAITING_CONFIRMATION',
        confirmation_request_id: requestId,
        
        // ✅ TIMER STATUS TRACKING
        player_status: 'playing',           // 'playing', 'on_break', 'call_time_active', 'removed'
        play_timer_status: 'counting',      // 'counting', 'paused', 'call_time'
        
        // ✅ TIME TRACKING FIELDS
        seated_at: seatedAt,
        played_time_before_break: 0,        // Accumulated seconds before breaks
        total_played_seconds: 0,            // Will be updated
        total_break_seconds: 0,
        total_time_played_minutes: 0,
        total_break_minutes: 0,
        
        // Minimum play time
        minimum_play_time: minimumPlayTime,
        minimum_play_until: minimumPlayUntil,
        
        // Break fields
        break_started_at: null,
        break_ends_at: null,
        break_duration: null,
        break_count: 0,
        
        // Call time fields
        call_time_requested_at: null,
        call_time_duration: null,
        call_time_ends_at: null,
        must_leave_at: null,
        
        is_removed: false,
        created_by: userId
      });
  
      // ✅ Update table occupied seats (sync with actual count)
      await this.syncTableOccupiedSeats(table_id);
  
      // Log time event
      await this.logTimeEvent(session.session_id, playerResult.insert_id, player.player_id, 'seated', {
        notes: `Seated at Table ${table.table_number}, Seat ${seat_number}. Buy-in: ₹${buy_in_amount}`,
        performed_by: userId
      });
  
      return {
        table_player_id: playerResult.insert_id,
        confirmation_request_id: requestId,
        player_id: player.player_id,
        player_name: player.player_name,
        table_id,
        table_number: table.table_number,
        seat_number,
        buy_in_amount,
        buy_in_status: 'AWAITING_CONFIRMATION',
        seated_at: seatedAt,
        minimum_play_until: minimumPlayUntil,
        message: `${player.player_name} seated on Table ${table.table_number}, Seat ${seat_number}`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ SET PLAYER ON BREAK
   * Timer: PAUSES play timer, starts break countdown
   */
  async setPlayerOnBreak(tablePlayerId, userId) {
    try {
      const player = await db.select(
        'tbl_table_players',
        '*',
        'table_player_id = ?',
        [tablePlayerId]
      );

      if (!player) {
        throw new Error('Player not found');
      }

      if (player.player_status === 'on_break') {
        throw new Error('Player is already on break');
      }

      const now = new Date();
      const seatedAt = new Date(player.seated_at);
      
      // ✅ Calculate current session time since seated_at
      const currentSessionSeconds = Math.floor((now - seatedAt) / 1000);
      
      // ✅ Previous accumulated play time (from before any previous breaks)
      const previousPlayedSeconds = parseInt(player.played_time_before_break) || 0;
      
      // ✅ Total played = previous accumulated + current session
      const totalPlayedSeconds = previousPlayedSeconds + currentSessionSeconds;
      const totalPlayedMinutes = Math.floor(totalPlayedSeconds / 60);

      // Break settings
      const breakDuration = 15; // 15 minutes
      const breakStartedAt = now;
      const breakEndsAt = new Date(now.getTime() + breakDuration * 60 * 1000);
      const breakCount = (player.break_count || 0) + 1;

      await db.update(
        'tbl_table_players',
        {
          player_status: 'on_break',
          play_timer_status: 'paused',
          
          // ✅ Store TOTAL played time in seconds (will be used when resuming)
          played_time_before_break: totalPlayedSeconds,
          total_played_seconds: totalPlayedSeconds,
          total_time_played_minutes: totalPlayedMinutes,
          
          // Break info
          break_started_at: breakStartedAt,
          break_duration: breakDuration,
          break_ends_at: breakEndsAt,
          break_count: breakCount,
          
          updated_at: now,
        },
        'table_player_id = ?',
        [tablePlayerId]
      );

      // Log event
      await this.logTimeEvent(player.session_id, tablePlayerId, player.player_id, 'break_started', {
        notes: `Break #${breakCount} started after ${totalPlayedMinutes} minutes of play. Returns at ${breakEndsAt.toLocaleTimeString()}`,
        performed_by: userId
      });

      return {
        success: true,
        break_started_at: breakStartedAt,
        break_ends_at: breakEndsAt,
        break_duration_minutes: breakDuration,
        break_count: breakCount,
        played_seconds_before_break: totalPlayedSeconds,
        played_minutes_before_break: totalPlayedMinutes,
        message: `Player on break. Must return by ${breakEndsAt.toLocaleTimeString()}`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ RESUME FROM BREAK
   * Timer: RESUMES play timer
   */
  async resumeFromBreak(tablePlayerId, userId) {
    try {
      const player = await db.select(
        'tbl_table_players',
        '*',
        'table_player_id = ?',
        [tablePlayerId]
      );

      if (!player) {
        throw new Error('Player not found');
      }

      if (player.player_status !== 'on_break') {
        throw new Error('Player is not on break');
      }

      const now = new Date();
      const breakStarted = new Date(player.break_started_at);
      const actualBreakSeconds = Math.floor((now - breakStarted) / 1000);
      const actualBreakMinutes = Math.floor(actualBreakSeconds / 60);
      
      // Calculate total break time
      const previousBreakSeconds = parseInt(player.total_break_seconds) || 0;
      const totalBreakSeconds = previousBreakSeconds + actualBreakSeconds;
      const totalBreakMinutes = Math.floor(totalBreakSeconds / 60);

      await db.update(
        'tbl_table_players',
        {
          player_status: 'playing',
          play_timer_status: 'counting',
          
          // ✅ Reset seated_at to NOW - this becomes the new session start
          // played_time_before_break already has the accumulated time
          seated_at: now,
          
          // Update total break time
          total_break_seconds: totalBreakSeconds,
          total_break_minutes: totalBreakMinutes,
          
          // Clear break fields
          break_started_at: null,
          break_ends_at: null,
          break_duration: null,
          
          updated_at: now,
        },
        'table_player_id = ?',
        [tablePlayerId]
      );

      // Log event
      await this.logTimeEvent(player.session_id, tablePlayerId, player.player_id, 'break_resumed', {
        notes: `Resumed after ${actualBreakMinutes} minute break. Total break time: ${totalBreakMinutes} minutes`,
        performed_by: userId
      });

      return {
        success: true,
        break_duration_minutes: actualBreakMinutes,
        total_break_minutes: totalBreakMinutes,
        resumed_at: now,
        total_played_seconds: parseInt(player.played_time_before_break) || 0,
        message: 'Player resumed from break'
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ CALL TIME - UPDATED TO 60 MINUTES
   * Timer: Switches to COUNTDOWN (60 minutes default)
   * 
   * Rules:
   * - Player must have played minimum 120 minutes first
   * - After call time, player gets 60 minute countdown
   * - When countdown reaches 0, player must leave
   */
  async callTime(tablePlayerId, userId) {
    try {
      const player = await db.select(
        'tbl_table_players',
        '*',
        'table_player_id = ?',
        [tablePlayerId]
      );

      if (!player) {
        throw new Error('Player not found');
      }

      if (player.player_status === 'call_time_active') {
        throw new Error('Call time already active');
      }

      // Calculate current played time
      const now = new Date();
      
      // ✅ FIXED: Use last_timer_update (resume time) instead of seated_at to avoid counting break time
      const seatedAt = new Date(player.seated_at);
      const sessionStart = player.last_timer_update 
        ? new Date(player.last_timer_update) 
        : seatedAt;
      const currentSessionSeconds = Math.max(0, Math.floor((now - sessionStart) / 1000));
      const accumulatedSeconds = parseInt(player.played_time_before_break) || 0;
      const totalPlayedSeconds = accumulatedSeconds + currentSessionSeconds;
      const totalPlayedMinutes = Math.floor(totalPlayedSeconds / 60);

      // Check minimum play time (120 minutes)
      const minimumMinutes = player.minimum_play_time || 120;
      if (totalPlayedMinutes < minimumMinutes) {
        const remainingMinutes = minimumMinutes - totalPlayedMinutes;
        throw new Error(`Player must play ${remainingMinutes} more minutes before calling time`);
      }

      // ✅ UPDATED: Set call time to 60 minutes (was 5 minutes)
      const callTimeDuration = 60; // 60 minutes countdown
      const callTimeRequestedAt = now;
      const callTimeEndsAt = new Date(now.getTime() + callTimeDuration * 60 * 1000);

      await db.update(
        'tbl_table_players',
        {
          player_status: 'call_time_active',
          play_timer_status: 'call_time',
          
          // Update total played time
          total_played_seconds: totalPlayedSeconds,
          total_time_played_minutes: totalPlayedMinutes,
          
          // Call time info
          call_time_requested_at: callTimeRequestedAt,
          call_time_duration: callTimeDuration,
          call_time_ends_at: callTimeEndsAt,
          must_leave_at: callTimeEndsAt,
          
          updated_at: now,
        },
        'table_player_id = ?',
        [tablePlayerId]
      );

      // Log event
      await this.logTimeEvent(player.session_id, tablePlayerId, player.player_id, 'call_time_started', {
        notes: `Call time after ${totalPlayedMinutes} minutes. Must leave by ${callTimeEndsAt.toLocaleTimeString()}`,
        performed_by: userId
      });

      return {
        success: true,
        call_time_requested_at: callTimeRequestedAt,
        call_time_ends_at: callTimeEndsAt,
        call_time_duration_minutes: callTimeDuration,
        total_played_minutes: totalPlayedMinutes,
        message: `Call time set. Player must leave in ${callTimeDuration} minutes`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ EXTEND CALL TIME
   */
  async extendCallTime(tablePlayerId, additionalMinutes = 15, userId) {
    try {
      const player = await db.select(
        'tbl_table_players',
        '*',
        'table_player_id = ?',
        [tablePlayerId]
      );

      if (!player) {
        throw new Error('Player not found');
      }

      if (player.player_status !== 'call_time_active') {
        throw new Error('Call time is not active');
      }

      const currentEndsAt = new Date(player.call_time_ends_at);
      const newEndsAt = new Date(currentEndsAt.getTime() + additionalMinutes * 60 * 1000);
      const newDuration = (player.call_time_duration || 60) + additionalMinutes;

      await db.update(
        'tbl_table_players',
        {
          call_time_duration: newDuration,
          call_time_ends_at: newEndsAt,
          must_leave_at: newEndsAt,
          updated_at: new Date()
        },
        'table_player_id = ?',
        [tablePlayerId]
      );

      // Log event
      await this.logTimeEvent(player.session_id, tablePlayerId, player.player_id, 'call_time_extended', {
        extended_by_minutes: additionalMinutes,
        new_call_time_ends_at: newEndsAt,
        notes: `Extended by ${additionalMinutes} minutes. New deadline: ${newEndsAt.toLocaleTimeString()}`,
        performed_by: userId
      });

      return {
        success: true,
        extended_by_minutes: additionalMinutes,
        new_call_time_ends_at: newEndsAt,
        total_call_time_duration: newDuration,
        message: `Call time extended by ${additionalMinutes} minutes`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ REMOVE PLAYER FROM TABLE
   */
  async removePlayer(tablePlayerId, userId, reason = null) {
    try {
      const player = await db.select(
        'tbl_table_players tp INNER JOIN tbl_tables t ON tp.table_id = t.table_id',
        'tp.*, t.table_number, t.current_occupied_seats',
        'tp.table_player_id = ?',
        [tablePlayerId]
      );

      if (!player) {
        throw new Error('Player not found');
      }

      if (player.is_removed) {
        throw new Error('Player already removed');
      }

      const now = new Date();
      
      // Calculate final total time
      const seatedAt = new Date(player.seated_at);
      const currentSessionSeconds = Math.floor((now - seatedAt) / 1000);
      const accumulatedSeconds = parseInt(player.played_time_before_break) || 0;
      const totalPlayedSeconds = accumulatedSeconds + currentSessionSeconds;
      const totalPlayedMinutes = Math.floor(totalPlayedSeconds / 60);
      const totalPlayedHours = parseFloat((totalPlayedMinutes / 60).toFixed(2));

      // Mark player as removed
      await db.update(
        'tbl_table_players',
        {
          is_removed: true,
          removed_at: now,
          removed_by: userId,
          player_status: 'removed',
          play_timer_status: 'completed',
          total_played_seconds: totalPlayedSeconds,
          total_time_played_minutes: totalPlayedMinutes,
          updated_at: now,
        },
        'table_player_id = ?',
        [tablePlayerId]
      );

      // ✅ Sync table occupied seats
      await this.syncTableOccupiedSeats(player.table_id);

      // Update player lifetime stats
      try {
        await this.updatePlayerTimeStats(player.player_id, totalPlayedMinutes);
      } catch (err) {
        console.error('Error updating player time stats:', err.message);
      }

      // Log event
      await this.logTimeEvent(player.session_id, tablePlayerId, player.player_id, 'removed', {
        notes: reason || `Played ${totalPlayedMinutes} minutes (${totalPlayedHours} hours) on Table ${player.table_number}`,
        performed_by: userId
      });

      return {
        success: true,
        total_played_minutes: totalPlayedMinutes,
        total_played_hours: totalPlayedHours,
        total_break_minutes: player.total_break_minutes || 0,
        message: `Player removed from Table ${player.table_number}. Total play time: ${totalPlayedMinutes} minutes.`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ UPDATE PLAYER TIME STATS
   */
  async updatePlayerTimeStats(playerId, sessionMinutes) {
    try {
      const player = await db.select('tbl_players', '*', 'player_id = ?', [playerId]);
      if (!player) return;

      const sessionHours = parseFloat((sessionMinutes / 60).toFixed(2));
      
      const updates = {
        visit_count: (player.visit_count || 0) + 1,
        last_visit_date: new Date(),
        updated_at: new Date(),
      };

      await db.update('tbl_players', updates, 'player_id = ?', [playerId]);
      
      console.log(`✅ Player ${playerId} stats updated: ${sessionMinutes} minutes (${sessionHours} hours)`);
    } catch (error) {
      console.error('Error updating player time stats:', error.message);
    }
  }

  /**
   * ✅ LOG TIME EVENT
   */
  async logTimeEvent(sessionId, tablePlayerId, playerId, eventType, data = {}) {
    try {
      await db.insert('tbl_player_time_log', {
        session_id: sessionId,
        table_player_id: tablePlayerId,
        player_id: playerId,
        event_type: eventType,
        event_time: new Date(),
        notes: data.notes || null,
        performed_by: data.performed_by || null
      });
    } catch (error) {
      console.error('Error logging time event:', error);
    }
  }

  /**
   * ✅ MARK BUY-IN AS COMPLETED
   */
  async markBuyinCompleted(tablePlayerId, userId) {
    try {
      const player = await db.select(
        'tbl_table_players',
        '*',
        'table_player_id = ?',
        [tablePlayerId]
      );

      if (!player) {
        throw new Error('Player not found');
      }

      if (player.buy_in_status === 'BUYIN_COMPLETED') {
        throw new Error('Buy-in already completed');
      }

      await db.update(
        'tbl_table_players',
        { 
          buy_in_status: 'BUYIN_COMPLETED',
          updated_at: new Date()
        },
        'table_player_id = ?',
        [tablePlayerId]
      );

      if (player.confirmation_request_id) {
        await db.update(
          'tbl_buyin_confirmation_requests',
          {
            request_status: 'confirmed',
            confirmed_by: userId,
            confirmed_at: new Date(),
            chips_issued: true
          },
          'request_id = ?',
          [player.confirmation_request_id]
        );
      }

      return {
        success: true,
        message: 'Buy-in marked as completed'
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ AUTO-REMOVE EXPIRED CALL TIME PLAYERS
   */
  async autoRemoveExpiredPlayers() {
    try {
      const session = await tableService.getCurrentSession();
      
      const expiredPlayers = await db.queryAll(
        `SELECT tp.*, p.player_name, t.table_number
         FROM tbl_table_players tp
         INNER JOIN tbl_players p ON tp.player_id = p.player_id
         INNER JOIN tbl_tables t ON tp.table_id = t.table_id
         WHERE tp.session_id = ?
           AND tp.is_removed = FALSE
           AND tp.player_status = 'call_time_active'
           AND tp.call_time_ends_at <= NOW()`,
        [session.session_id]
      );

      if (!expiredPlayers || expiredPlayers.length === 0) {
        return {
          success: true,
          removed_count: 0,
          message: 'No expired players found'
        };
      }

      const removedPlayers = [];

      for (const player of expiredPlayers) {
        try {
          await this.removePlayer(player.table_player_id, 1, 'Auto-removed: Call time expired');
          removedPlayers.push({
            player_name: player.player_name,
            table_number: player.table_number,
            seat_number: player.seat_number
          });
        } catch (err) {
          console.error(`Failed to auto-remove player ${player.player_name}:`, err);
        }
      }

      return {
        success: true,
        removed_count: removedPlayers.length,
        removed_players: removedPlayers,
        message: `Auto-removed ${removedPlayers.length} players`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ TRANSFER PLAYER TO ANOTHER TABLE
   */
  async transferPlayer(tablePlayerId, newTableId, newSeatNumber, userId) {
    try {
      const player = await db.select(
        'tbl_table_players',
        '*',
        'table_player_id = ? AND is_removed = FALSE',
        [tablePlayerId]
      );
  
      if (!player) {
        throw new Error('Player not found or already removed');
      }
  
      const newTable = await db.select(
        'tbl_tables',
        '*',
        'table_id = ? AND table_status = "active"',
        [newTableId]
      );
  
      if (!newTable) {
        throw new Error('Destination table not found or inactive');
      }
  
      const seatOccupied = await db.select(
        'tbl_table_players',
        'table_player_id',
        'table_id = ? AND seat_number = ? AND is_removed = FALSE',
        [newTableId, newSeatNumber]
      );
  
      if (seatOccupied) {
        throw new Error(`Seat ${newSeatNumber} is already occupied on table ${newTable.table_number}`);
      }
  
      const now = new Date();
      const oldTableId = player.table_id;
      const oldSeatNumber = player.seat_number;
  
      // Calculate current played time
      let totalPlayedSeconds = 0;
      
      if (player.player_status === 'playing' && player.seated_at) {
        const seatedAt = new Date(player.seated_at);
        const currentSessionSeconds = Math.floor((now - seatedAt) / 1000);
        const accumulatedSeconds = parseInt(player.played_time_before_break) || 0;
        totalPlayedSeconds = accumulatedSeconds + currentSessionSeconds;
      } else if (player.player_status === 'on_break') {
        totalPlayedSeconds = parseInt(player.played_time_before_break) || 0;
      } else {
        totalPlayedSeconds = parseInt(player.total_played_seconds) || 
                            parseInt(player.played_time_before_break) || 0;
      }
  
      // Update player to new table/seat
      await db.update(
        'tbl_table_players',
        {
          table_id: newTableId,
          seat_number: newSeatNumber,
          played_time_before_break: totalPlayedSeconds,
          seated_at: now,
          updated_at: now,
        },
        'table_player_id = ?',
        [tablePlayerId]
      );
  
      // Update table counts
      await db.query(
        `UPDATE tbl_tables SET current_occupied_seats = current_occupied_seats - 1 WHERE table_id = ?`,
        [oldTableId]
      );
  
      await db.query(
        `UPDATE tbl_tables SET current_occupied_seats = current_occupied_seats + 1 WHERE table_id = ?`,
        [newTableId]
      );
  
      // Log transfer
      try {
        await db.insert('tbl_player_time_log', {
          session_id: player.session_id,
          table_player_id: tablePlayerId,
          player_id: player.player_id,
          event_type: 'transfer',
          event_time: now,
          performed_by: userId,
          notes: `Transferred from Table ${oldTableId} Seat ${oldSeatNumber} to Table ${newTableId} Seat ${newSeatNumber}`,
        });
      } catch (logError) {
        console.warn('Failed to log transfer:', logError.message);
      }
  
      const playerInfo = await db.select('tbl_players', 'player_name', 'player_id = ?', [player.player_id]);
  
      return {
        success: true,
        table_player_id: tablePlayerId,
        player_name: playerInfo?.player_name,
        from_table: oldTableId,
        from_seat: oldSeatNumber,
        to_table: newTableId,
        to_table_number: newTable.table_number,
        to_seat: newSeatNumber,
        preserved_play_time_seconds: totalPlayedSeconds,
        message: `${playerInfo?.player_name} transferred to Table ${newTable.table_number} Seat ${newSeatNumber}`
      };
    } catch (error) {
      console.error('Transfer player error:', error);
      throw error;
    }
  }

  /**
   * ✅ GET PLAYER TIME HISTORY
   */
  async getPlayerTimeHistory(tablePlayerId) {
    try {
      const logs = await db.selectAll(
        'tbl_player_time_log',
        '*',
        'table_player_id = ?',
        [tablePlayerId],
        'ORDER BY event_time DESC'
      );

      return logs || [];
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ GET PLAYER CURRENT TIMER STATUS
   */
  async getPlayerTimerStatus(tablePlayerId) {
    try {
      const player = await db.select(
        'tbl_table_players',
        '*',
        'table_player_id = ?',
        [tablePlayerId]
      );

      if (!player) {
        throw new Error('Player not found');
      }

      const now = new Date();
      const seatedAt = new Date(player.seated_at);
      const accumulatedSeconds = parseInt(player.played_time_before_break) || 0;
      
      let currentPlayedSeconds = accumulatedSeconds;
      let breakRemainingSeconds = null;
      let callTimeRemainingSeconds = null;

      switch (player.player_status) {
        case 'playing':
          // Add current session time
          currentPlayedSeconds = accumulatedSeconds + Math.floor((now - seatedAt) / 1000);
          break;

        case 'on_break':
          // Frozen at accumulated time
          currentPlayedSeconds = accumulatedSeconds;
          if (player.break_ends_at) {
            const breakEndsAt = new Date(player.break_ends_at);
            breakRemainingSeconds = Math.max(0, Math.floor((breakEndsAt - now) / 1000));
          }
          break;

        case 'call_time_active':
          if (player.call_time_ends_at) {
            const callTimeEndsAt = new Date(player.call_time_ends_at);
            callTimeRemainingSeconds = Math.floor((callTimeEndsAt - now) / 1000);
          }
          break;
      }

      const minimumPlaySeconds = (player.minimum_play_time || 120) * 60;

      return {
        table_player_id: tablePlayerId,
        player_status: player.player_status,
        play_timer_status: player.play_timer_status,
        
        played_seconds: currentPlayedSeconds,
        played_minutes: Math.floor(currentPlayedSeconds / 60),
        
        remaining_seconds: minimumPlaySeconds - currentPlayedSeconds,
        remaining_minutes: Math.floor((minimumPlaySeconds - currentPlayedSeconds) / 60),
        
        break_remaining_seconds: breakRemainingSeconds,
        break_remaining_minutes: breakRemainingSeconds ? Math.floor(breakRemainingSeconds / 60) : null,
        
        call_time_remaining_seconds: callTimeRemainingSeconds,
        call_time_remaining_minutes: callTimeRemainingSeconds ? Math.floor(callTimeRemainingSeconds / 60) : null,
        
        minimum_play_time: player.minimum_play_time || 120,
        can_call_time: currentPlayedSeconds >= minimumPlaySeconds,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ SYNC TABLE OCCUPIED SEATS
   */
  async syncTableOccupiedSeats(tableId) {
    try {
      const result = await db.query(
        `SELECT COUNT(*) as count FROM tbl_table_players 
         WHERE table_id = ? AND is_removed = FALSE`,
        [tableId]
      );

      const actualCount = result?.count || 0;

      await db.update(
        'tbl_tables',
        { current_occupied_seats: actualCount },
        'table_id = ?',
        [tableId]
      );

      return actualCount;
    } catch (error) {
      console.error('Error syncing table seats:', error);
      return 0;
    }
  }
}

module.exports = new PlayerService();