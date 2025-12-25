// ============================================
// FILE: modules/floor-manager/services/player-timer.service.js
// Enhanced player countdown timer management
// ============================================

const db = require('../../../config/database');
const tableService = require('./table.service');

class PlayerTimerService {
  /**
   * ✅ ADD PLAYER - START COUNTDOWN
   * Player seated → play timer starts (120 min minimum)
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
      const table = await db.select('tbl_tables', '*', 'table_id = ?', [table_id]);

      if (!table) throw new Error('Table not found');
      if (table.current_occupied_seats >= table.max_seats) throw new Error('Table full');

      // Check seat availability
      const seatOccupied = await db.select(
        'tbl_table_players',
        'table_player_id',
        'table_id = ? AND seat_number = ? AND is_removed = FALSE',
        [table_id, seat_number]
      );

      if (seatOccupied) throw new Error(`Seat ${seat_number} is occupied`);

      const player = await db.select('tbl_players', '*', 'player_id = ?', [player_id]);
      if (!player) throw new Error('Player not found');

      // ✅ TIMER SETTINGS
      const minimumPlayTime = 120; // 120 minutes
      const minimumPlayUntil = new Date(Date.now() + minimumPlayTime * 60 * 1000);
      const seatedAt = new Date();

      // ✅ CREATE BUY-IN CONFIRMATION
      const requestResult = await db.insert('tbl_buyin_confirmation_requests', {
        session_id: session.session_id,
        table_id,
        player_id,
        seat_number,
        buy_in_amount,
        collected_by: userId,
        request_status: 'pending',
        created_at: seatedAt
      });

      // ✅ SEAT PLAYER WITH TIMER TRACKING
      const playerResult = await db.insert('tbl_table_players', {
        session_id: session.session_id,
        table_id,
        player_id,
        seat_number,
        buy_in_amount,
        buy_in_status: 'AWAITING_CONFIRMATION',
        confirmation_request_id: requestResult.insert_id,
        player_status: 'playing',
        
        // ✅ Timer tracking
        play_timer_status: 'playing',
        play_start_time: seatedAt,
        play_duration_remaining_seconds: minimumPlayTime * 60,
        
        seated_at: seatedAt,
        minimum_play_time: minimumPlayTime,
        minimum_play_until: minimumPlayUntil,
        
        created_by: userId,
        last_timer_update: seatedAt
      });

      const tablePlayerId = playerResult.insert_id;

      // Update table occupied seats
      await db.update(
        'tbl_tables',
        { current_occupied_seats: table.current_occupied_seats + 1 },
        'table_id = ?',
        [table_id]
      );

      // ✅ LOG TIMER START EVENT
      await this.logTimerEvent({
        session_id: session.session_id,
        entity_type: 'player',
        entity_id: player_id,
        table_id,
        timer_type: 'play',
        event_type: 'timer_started',
        total_duration_seconds: minimumPlayTime * 60,
        elapsed_seconds: 0,
        remaining_seconds: minimumPlayTime * 60,
        performed_by: userId,
        notes: `Player seated. Minimum play: ${minimumPlayTime} minutes`
      });

      // Audit log
      await db.insert('tbl_player_time_log', {
        session_id: session.session_id,
        table_player_id: tablePlayerId,
        player_id,
        event_type: 'seated',
        event_time: seatedAt,
        notes: `Seated on Table ${table.table_number}, Seat ${seat_number}. Play timer: ${minimumPlayTime}m`,
        performed_by: userId
      });

      return {
        table_player_id: tablePlayerId,
        confirmation_request_id: requestResult.insert_id,
        player_name: player.player_name,
        play_timer_status: 'playing',
        play_start_time: seatedAt,
        minimum_play_minutes: minimumPlayTime,
        message: `${player.player_name} seated. Play timer: ${minimumPlayTime}m`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ PLAYER ON BREAK - PAUSE PLAY TIMER, START BREAK TIMER
   */
  async setPlayerOnBreak(tablePlayerId, userId) {
    try {
      const player = await db.select('tbl_table_players', '*', 'table_player_id = ?', [tablePlayerId]);
      if (!player) throw new Error('Player not found');
      if (player.player_status === 'on_break') throw new Error('Already on break');

      const now = new Date();
      const breakDuration = 15; // 15 minutes
      const breakEndsAt = new Date(now.getTime() + breakDuration * 60 * 1000);

      // ✅ CALCULATE ELAPSED PLAY TIME
      const playStartTime = new Date(player.play_start_time);
      const elapsedMs = now - playStartTime;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      const remainingPlaySeconds = Math.max(0, player.play_duration_remaining_seconds - elapsedSeconds);
      const playedTimeBeforeBreak = Math.floor(elapsedSeconds / 60);

      // ✅ UPDATE: PAUSE PLAY TIMER, START BREAK TIMER
      await db.update(
        'tbl_table_players',
        {
          player_status: 'on_break',
          
          // ✅ Pause play timer
          play_timer_status: 'paused',
          play_paused_time: now,
          play_paused_remaining_seconds: remainingPlaySeconds,
          played_time_before_break: playedTimeBeforeBreak,
          
          // ✅ Start break timer
          break_start_time: now,
          break_paused_remaining_seconds: breakDuration * 60,
          break_ends_at: breakEndsAt,
          
          last_timer_update: now
        },
        'table_player_id = ?',
        [tablePlayerId]
      );

      // ✅ LOG PLAY PAUSE
      await this.logTimerEvent({
        session_id: player.session_id,
        entity_type: 'player',
        entity_id: player.player_id,
        table_id: player.table_id,
        timer_type: 'play',
        event_type: 'timer_paused',
        total_duration_seconds: player.play_duration_remaining_seconds,
        elapsed_seconds: elapsedSeconds,
        remaining_seconds: remainingPlaySeconds,
        performed_by: userId,
        notes: `Play paused after ${playedTimeBeforeBreak}m. Remaining: ${Math.floor(remainingPlaySeconds / 60)}m`
      });

      // ✅ LOG BREAK START
      await this.logTimerEvent({
        session_id: player.session_id,
        entity_type: 'player',
        entity_id: player.player_id,
        table_id: player.table_id,
        timer_type: 'break',
        event_type: 'timer_started',
        total_duration_seconds: breakDuration * 60,
        elapsed_seconds: 0,
        remaining_seconds: breakDuration * 60,
        performed_by: userId,
        notes: `Break started. Duration: ${breakDuration} minutes`
      });

      // Audit log
      await db.insert('tbl_player_time_log', {
        session_id: player.session_id,
        table_player_id: tablePlayerId,
        player_id: player.player_id,
        event_type: 'break_started',
        event_time: now,
        notes: `Break started after ${playedTimeBeforeBreak}m. Resume in ${breakDuration}m`,
        performed_by: userId
      });

      return {
        success: true,
        played_before_break_minutes: playedTimeBeforeBreak,
        break_duration_minutes: breakDuration,
        break_ends_at: breakEndsAt,
        remaining_play_minutes: Math.ceil(remainingPlaySeconds / 60),
        message: `Player on break. Played: ${playedTimeBeforeBreak}m. Remaining: ${Math.ceil(remainingPlaySeconds / 60)}m`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ PLAYER RESUMES - PAUSE BREAK TIMER, RESUME PLAY TIMER
   */
  async resumePlayerFromBreak(tablePlayerId, userId) {
    try {
      const player = await db.select('tbl_table_players', '*', 'table_player_id = ?', [tablePlayerId]);
      if (!player) throw new Error('Player not found');
      if (player.player_status !== 'on_break') throw new Error('Player not on break');

      const now = new Date();

      // ✅ CALCULATE BREAK DURATION
      const breakStartTime = new Date(player.break_start_time);
      const breakElapsedMs = now - breakStartTime;
      const breakElapsedSeconds = Math.floor(breakElapsedMs / 1000);

      // ✅ RESTORE PLAY TIMER: RESUME FROM PAUSE
      // New play_start_time = now (reset to current time)
      // play_duration_remaining_seconds = already saved in play_paused_remaining_seconds
      const remainingPlaySeconds = player.play_paused_remaining_seconds;
      const newMinimumPlayUntil = new Date(now.getTime() + remainingPlaySeconds * 1000);

      await db.update(
        'tbl_table_players',
        {
          player_status: 'playing',
          
          // ✅ Resume play timer
          play_timer_status: 'resumed',
          play_start_time: now, // Reset start time
          play_paused_time: null,
          play_paused_remaining_seconds: 0,
          play_duration_remaining_seconds: remainingPlaySeconds,
          minimum_play_until: newMinimumPlayUntil,
          
          // Clear break timer
          break_start_time: null,
          break_paused_remaining_seconds: 0,
          break_ends_at: null,
          
          last_timer_update: now
        },
        'table_player_id = ?',
        [tablePlayerId]
      );

      // ✅ LOG BREAK END
      await this.logTimerEvent({
        session_id: player.session_id,
        entity_type: 'player',
        entity_id: player.player_id,
        table_id: player.table_id,
        timer_type: 'break',
        event_type: 'timer_completed',
        total_duration_seconds: Math.floor(player.break_paused_remaining_seconds),
        elapsed_seconds: breakElapsedSeconds,
        remaining_seconds: 0,
        performed_by: userId,
        notes: `Break completed after ${Math.floor(breakElapsedSeconds / 60)}m`
      });

      // ✅ LOG PLAY RESUME
      await this.logTimerEvent({
        session_id: player.session_id,
        entity_type: 'player',
        entity_id: player.player_id,
        table_id: player.table_id,
        timer_type: 'play',
        event_type: 'timer_resumed',
        total_duration_seconds: remainingPlaySeconds,
        elapsed_seconds: 0,
        remaining_seconds: remainingPlaySeconds,
        performed_by: userId,
        notes: `Play resumed. Remaining: ${Math.ceil(remainingPlaySeconds / 60)}m`
      });

      // Audit log
      await db.insert('tbl_player_time_log', {
        session_id: player.session_id,
        table_player_id: tablePlayerId,
        player_id: player.player_id,
        event_type: 'break_resumed',
        event_time: now,
        notes: `Resumed from break. Remaining play time: ${Math.ceil(remainingPlaySeconds / 60)}m`,
        performed_by: userId
      });

      return {
        success: true,
        break_duration_minutes: Math.floor(breakElapsedSeconds / 60),
        remaining_play_minutes: Math.ceil(remainingPlaySeconds / 60),
        message: `Player resumed. Remaining play: ${Math.ceil(remainingPlaySeconds / 60)}m`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ CALL TIME - ACTIVATE CALL TIME TIMER
   * Player wants to leave after 120 min → 60 more minutes
   */
  async callTime(tablePlayerId, userId) {
    try {
      const player = await db.select('tbl_table_players', '*', 'table_player_id = ?', [tablePlayerId]);
      if (!player) throw new Error('Player not found');
      if (player.player_status === 'call_time_active') throw new Error('Call time already active');

      const now = new Date();
      const minimumPlayUntil = new Date(player.minimum_play_until);

      // Check if minimum time has passed
      if (now < minimumPlayUntil) {
        const remainingMs = minimumPlayUntil - now;
        const remainingMinutes = Math.floor(remainingMs / (1000 * 60));
        throw new Error(`Must play ${remainingMinutes} more minutes before call time`);
      }

      // ✅ SET CALL TIME
      const callTimeDuration = 60; // 60 minutes
      const callTimeEndsAt = new Date(now.getTime() + callTimeDuration * 60 * 1000);

      // Calculate total played time
      const playStartTime = new Date(player.play_start_time);
      const totalPlayedMs = now - playStartTime;
      const totalPlayedSeconds = Math.floor(totalPlayedMs / 1000);

      await db.update(
        'tbl_table_players',
        {
          player_status: 'call_time_active',
          
          // ✅ Call time timer
          play_timer_status: 'call_time',
          call_time_start_time: now,
          call_time_paused_remaining_seconds: callTimeDuration * 60,
          call_time_ends_at: callTimeEndsAt,
          
          last_timer_update: now
        },
        'table_player_id = ?',
        [tablePlayerId]
      );

      // ✅ LOG CALL TIME START
      await this.logTimerEvent({
        session_id: player.session_id,
        entity_type: 'player',
        entity_id: player.player_id,
        table_id: player.table_id,
        timer_type: 'call_time',
        event_type: 'timer_started',
        total_duration_seconds: callTimeDuration * 60,
        elapsed_seconds: 0,
        remaining_seconds: callTimeDuration * 60,
        performed_by: userId,
        notes: `Call time activated. Must leave in ${callTimeDuration}m. Total played: ${Math.floor(totalPlayedSeconds / 60)}m`
      });

      // Audit log
      await db.insert('tbl_player_time_log', {
        session_id: player.session_id,
        table_player_id: tablePlayerId,
        player_id: player.player_id,
        event_type: 'call_time_started',
        event_time: now,
        notes: `Call time activated. Must leave by ${callTimeEndsAt.toLocaleTimeString()}`,
        performed_by: userId
      });

      return {
        success: true,
        call_time_duration_minutes: callTimeDuration,
        call_time_ends_at: callTimeEndsAt,
        message: `Call time activated. ${callTimeDuration} minutes remaining`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ EXTEND CALL TIME
   */
  async extendCallTime(tablePlayerId, additionalMinutes = 30, userId) {
    try {
      const player = await db.select('tbl_table_players', '*', 'table_player_id = ?', [tablePlayerId]);
      if (!player) throw new Error('Player not found');
      if (player.player_status !== 'call_time_active') throw new Error('Call time not active');

      const now = new Date();
      const additionalSeconds = additionalMinutes * 60;
      
      // Calculate new end time
      const currentEndsAt = new Date(player.call_time_ends_at);
      const newEndsAt = new Date(currentEndsAt.getTime() + additionalSeconds * 1000);
      
      // Update remaining time
      const currentRemaining = player.call_time_paused_remaining_seconds;
      const newRemaining = currentRemaining + additionalSeconds;

      await db.update(
        'tbl_table_players',
        {
          call_time_paused_remaining_seconds: newRemaining,
          call_time_ends_at: newEndsAt,
          last_timer_update: now
        },
        'table_player_id = ?',
        [tablePlayerId]
      );

      // ✅ LOG EXTENSION
      await this.logTimerEvent({
        session_id: player.session_id,
        entity_type: 'player',
        entity_id: player.player_id,
        table_id: player.table_id,
        timer_type: 'call_time',
        event_type: 'timer_extended',
        total_duration_seconds: newRemaining,
        elapsed_seconds: 0,
        remaining_seconds: newRemaining,
        performed_by: userId,
        notes: `Call time extended by ${additionalMinutes}m`
      });

      // Audit log
      await db.insert('tbl_player_time_log', {
        session_id: player.session_id,
        table_player_id: tablePlayerId,
        player_id: player.player_id,
        event_type: 'call_time_extended',
        event_time: now,
        notes: `Call time extended by ${additionalMinutes}m. New deadline: ${newEndsAt.toLocaleTimeString()}`,
        performed_by: userId
      });

      return {
        success: true,
        extended_by_minutes: additionalMinutes,
        new_remaining_minutes: Math.ceil(newRemaining / 60),
        message: `Call time extended by ${additionalMinutes} minutes`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ REMOVE PLAYER
   */
  async removePlayer(tablePlayerId, userId, reason = null) {
    try {
      const player = await db.select(
        'tbl_table_players tp INNER JOIN tbl_tables t ON tp.table_id = t.table_id',
        'tp.*, t.table_number, t.current_occupied_seats',
        'tp.table_player_id = ?',
        [tablePlayerId]
      );

      if (!player) throw new Error('Player not found');
      if (player.is_removed) throw new Error('Already removed');

      const now = new Date();

      // Calculate total play time
      const playStartTime = new Date(player.play_start_time);
      const totalPlayedMs = now - playStartTime;
      const totalPlayedSeconds = Math.floor(totalPlayedMs / 1000);
      const totalPlayedMinutes = Math.floor(totalPlayedSeconds / 60);

      // ✅ MARK REMOVED: STOP ALL TIMERS
      await db.update(
        'tbl_table_players',
        {
          is_removed: true,
          removed_at: now,
          removed_by: userId,
          player_status: 'removed',
          
          // Stop timers
          play_timer_status: 'completed',
          play_paused_time: null,
          break_start_time: null,
          call_time_start_time: null,
          
          total_time_played_minutes: totalPlayedMinutes,
          last_timer_update: now
        },
        'table_player_id = ?',
        [tablePlayerId]
      );

      // Update table occupied seats
      await db.update(
        'tbl_tables',
        { current_occupied_seats: Math.max(0, player.current_occupied_seats - 1) },
        'table_id = ?',
        [player.table_id]
      );

      // ✅ LOG FINAL TIMER STATE
      await this.logTimerEvent({
        session_id: player.session_id,
        entity_type: 'player',
        entity_id: player.player_id,
        table_id: player.table_id,
        timer_type: 'play',
        event_type: 'timer_completed',
        total_duration_seconds: totalPlayedSeconds,
        elapsed_seconds: totalPlayedSeconds,
        remaining_seconds: 0,
        performed_by: userId,
        notes: `Player removed. Total play time: ${totalPlayedMinutes}m. Reason: ${reason || 'Manual removal'}`
      });

      // Audit log
      await db.insert('tbl_player_time_log', {
        session_id: player.session_id,
        table_player_id: tablePlayerId,
        player_id: player.player_id,
        event_type: 'removed',
        event_time: now,
        notes: reason || `Removed after ${totalPlayedMinutes}m`,
        performed_by: userId
      });

      return {
        success: true,
        total_played_minutes: totalPlayedMinutes,
        message: `Player removed from Table ${player.table_number}`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ LOG TIMER EVENT
   */
  async logTimerEvent(data) {
    try {
      const {
        session_id,
        entity_type,
        entity_id,
        table_id,
        timer_type,
        event_type,
        total_duration_seconds,
        elapsed_seconds,
        remaining_seconds,
        performed_by,
        notes
      } = data;

      await db.insert('tbl_countdown_events', {
        session_id,
        entity_type,
        entity_id,
        table_id: table_id || null,
        timer_type,
        event_type,
        total_duration_seconds,
        elapsed_seconds,
        remaining_seconds,
        event_time: new Date(),
        performed_by: performed_by || null,
        notes
      });
    } catch (error) {
      console.error('Failed to log timer event:', error);
    }
  }

  /**
   * ✅ GET PLAYER TIMER STATE
   * Returns current countdown state for frontend
   */
  async getPlayerTimerState(tablePlayerId, sessionId) {
    try {
      const player = await db.select('tbl_table_players', '*', 'table_player_id = ?', [tablePlayerId]);
      if (!player) return null;

      const now = new Date();
      let timerState = {
        table_player_id: tablePlayerId,
        player_status: player.player_status,
        timer_status: player.play_timer_status
      };

      if (player.player_status === 'playing') {
        const playStartTime = new Date(player.play_start_time);
        const elapsedMs = now - playStartTime;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        const remainingSeconds = Math.max(0, player.play_duration_remaining_seconds - elapsedSeconds);

        timerState = {
          ...timerState,
          timer_type: 'play',
          elapsed_seconds: elapsedSeconds,
          remaining_seconds: remainingSeconds,
          remaining_minutes: Math.ceil(remainingSeconds / 60),
          minimum_play_until: player.minimum_play_until
        };
      } else if (player.player_status === 'on_break') {
        const breakStartTime = new Date(player.break_start_time);
        const elapsedMs = now - breakStartTime;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        const breakDurationSeconds = player.break_paused_remaining_seconds || 900; // Default 15m
        const remainingSeconds = Math.max(0, breakDurationSeconds - elapsedSeconds);

        timerState = {
          ...timerState,
          timer_type: 'break',
          elapsed_seconds: elapsedSeconds,
          remaining_seconds: remainingSeconds,
          remaining_minutes: Math.ceil(remainingSeconds / 60),
          played_before_break: player.played_time_before_break,
          break_ends_at: player.break_ends_at
        };
      } else if (player.player_status === 'call_time_active') {
        const callTimeStartTime = new Date(player.call_time_start_time);
        const elapsedMs = now - callTimeStartTime;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        const remainingSeconds = Math.max(0, player.call_time_paused_remaining_seconds - elapsedSeconds);

        timerState = {
          ...timerState,
          timer_type: 'call_time',
          elapsed_seconds: elapsedSeconds,
          remaining_seconds: remainingSeconds,
          remaining_minutes: Math.ceil(remainingSeconds / 60),
          call_time_ends_at: player.call_time_ends_at
        };
      }

      return timerState;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = new PlayerTimerService();