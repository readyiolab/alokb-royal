// ============================================
// FILE: modules/floor-manager/services/dealer-timer.service.js
// Enhanced dealer countdown timer management
// ============================================

const db = require('../../../config/database');
const tableService = require('./table.service');

class DealerTimerService {
  /**
   * ✅ ASSIGN DEALER - START COUNTDOWN
   * Creates initial shift record with countdown tracking
   */
  async assignDealerToTable(tableId, dealerId, userId) {
    try {
      const session = await tableService.getCurrentSession();
      const dealer = await db.select('tbl_dealers', '*', 'dealer_id = ?', [dealerId]);

      if (!dealer) throw new Error('Dealer not found');

      const shiftDuration = 60; // 60 minutes standard shift
      const now = new Date();
      const shiftEndsAt = new Date(now.getTime() + shiftDuration * 60 * 1000);

      // ✅ CREATE SHIFT WITH TIMER TRACKING
      const shiftResult = await db.insert('tbl_dealer_shifts', {
        session_id: session.session_id,
        dealer_id: dealerId,
        table_id: tableId,
        
        // ✅ Timer state
        shift_timer_status: 'playing', // Start immediately in playing state
        shift_start_time: now,
        shift_duration_remaining_seconds: shiftDuration * 60, // Total seconds
        shift_duration_minutes: shiftDuration,
        
        shift_status: 'on_table',
        current_shift_started_at: now,
        shift_ends_at: shiftEndsAt,
        assigned_by: userId,
        
        last_timer_update: now
      });

      // ✅ LOG EVENT
      await this.logTimerEvent({
        session_id: session.session_id,
        entity_type: 'dealer',
        entity_id: dealerId,
        table_id: tableId,
        timer_type: 'shift',
        event_type: 'timer_started',
        total_duration_seconds: shiftDuration * 60,
        elapsed_seconds: 0,
        remaining_seconds: shiftDuration * 60,
        performed_by: userId,
        notes: `Shift assigned to Table ${tableId}. Duration: ${shiftDuration} minutes`
      });

      // Update dealer status
      await db.update('tbl_dealers', { dealer_status: 'on_table' }, 'dealer_id = ?', [dealerId]);

      return {
        shift_id: shiftResult.insert_id,
        dealer_id: dealerId,
        table_id: tableId,
        shift_duration_minutes: shiftDuration,
        shift_timer_status: 'playing',
        shift_start_time: now,
        shift_duration_remaining_seconds: shiftDuration * 60,
        message: `Dealer assigned with ${shiftDuration} minute countdown`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ SEND DEALER ON BREAK - PAUSE COUNTDOWN
   * Pause shift timer, start break timer
   */
  async sendDealerOnBreak(dealerId, userId) {
    try {
      const session = await tableService.getCurrentSession();
      const dealer = await db.select('tbl_dealers', '*', 'dealer_id = ?', [dealerId]);

      if (!dealer) throw new Error('Dealer not found');

      // Get active shift
      const shift = await db.select(
        'tbl_dealer_shifts',
        '*',
        'dealer_id = ? AND session_id = ? AND shift_status = "on_table"',
        [dealerId, session.session_id]
      );

      if (!shift) throw new Error('No active shift found');

      const now = new Date();
      const tableId = shift.table_id;

      // ✅ CALCULATE ELAPSED TIME
      const shiftStartTime = new Date(shift.shift_start_time);
      const elapsedMs = now - shiftStartTime;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      const remainingSeconds = Math.max(0, shift.shift_duration_remaining_seconds - elapsedSeconds);

      // Break settings
      const breakDuration = 15; // 15 minutes
      const breakEndsAt = new Date(now.getTime() + breakDuration * 60 * 1000);

      // ✅ UPDATE SHIFT: PAUSE STATE
      await db.update(
        'tbl_dealer_shifts',
        {
          shift_timer_status: 'paused', // ✅ Status = paused
          shift_paused_time: now, // ✅ When it was paused
          shift_paused_remaining_seconds: remainingSeconds, // ✅ Save remaining time
          
          // Break info
          shift_status: 'on_break',
          break_started_at: now,
          break_duration_minutes: breakDuration,
          break_ends_at: breakEndsAt,
          
          last_timer_update: now
        },
        'shift_id = ?',
        [shift.shift_id]
      );

      // ✅ LOG PAUSE EVENT
      await this.logTimerEvent({
        session_id: session.session_id,
        entity_type: 'dealer',
        entity_id: dealerId,
        table_id: tableId,
        timer_type: 'shift',
        event_type: 'timer_paused',
        total_duration_seconds: shift.shift_duration_remaining_seconds,
        elapsed_seconds: elapsedSeconds,
        remaining_seconds: remainingSeconds,
        performed_by: userId,
        notes: `Shift paused. Elapsed: ${Math.floor(elapsedSeconds / 60)}m. Remaining: ${Math.floor(remainingSeconds / 60)}m`
      });

      // ✅ START BREAK TIMER
      await this.logTimerEvent({
        session_id: session.session_id,
        entity_type: 'dealer',
        entity_id: dealerId,
        table_id: tableId,
        timer_type: 'break',
        event_type: 'timer_started',
        total_duration_seconds: breakDuration * 60,
        elapsed_seconds: 0,
        remaining_seconds: breakDuration * 60,
        performed_by: userId,
        notes: `Break started. Duration: ${breakDuration} minutes`
      });

      // Remove from table
      await db.update('tbl_tables', { dealer_id: null }, 'table_id = ?', [tableId]);

      // Update dealer status
      await db.update('tbl_dealers', { dealer_status: 'on_break' }, 'dealer_id = ?', [dealerId]);

      // ✅ AUTO-ASSIGN ANOTHER DEALER
      let newDealer = null;
      try {
        newDealer = await db.select(
          'tbl_dealers',
          '*',
          'dealer_status = "available" ORDER BY RAND() LIMIT 1'
        );

        if (newDealer) {
          await this.assignDealerToTable(tableId, newDealer.dealer_id, userId);
        }
      } catch (err) {
        console.log('Auto-assign failed:', err.message);
      }

      return {
        success: true,
        dealer_name: dealer.dealer_name,
        break_ends_at: breakEndsAt,
        remaining_shift_time_minutes: Math.floor(remainingSeconds / 60),
        auto_assigned_new_dealer: !!newDealer,
        message: `${dealer.dealer_name} sent on break. Shift paused with ${Math.floor(remainingSeconds / 60)}m remaining.`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ RESUME DEALER FROM BREAK - RESUME COUNTDOWN
   * Pause break timer, resume shift timer
   */
  async resumeDealerFromBreak(dealerId, userId) {
    try {
      const session = await tableService.getCurrentSession();
      const dealer = await db.select('tbl_dealers', '*', 'dealer_id = ?', [dealerId]);

      if (!dealer) throw new Error('Dealer not found');

      const shift = await db.select(
        'tbl_dealer_shifts',
        '*',
        'dealer_id = ? AND session_id = ? AND shift_status = "on_break"',
        [dealerId, session.session_id]
      );

      if (!shift) throw new Error('Dealer not on break');

      const now = new Date();
      const tableId = shift.table_id;

      // ✅ CALCULATE BREAK DURATION
      const breakStartTime = new Date(shift.break_started_at);
      const breakElapsedMs = now - breakStartTime;
      const breakElapsedSeconds = Math.floor(breakElapsedMs / 1000);

      // ✅ RESTORE SHIFT: RESUME STATE
      // New shift end time = now + remaining time
      const remainingShiftSeconds = shift.shift_paused_remaining_seconds;
      const newShiftEndTime = new Date(now.getTime() + remainingShiftSeconds * 1000);

      await db.update(
        'tbl_dealer_shifts',
        {
          shift_timer_status: 'resumed', // ✅ Status = resumed
          shift_start_time: now, // ✅ Reset start time to now
          shift_paused_time: null, // Clear pause time
          shift_paused_remaining_seconds: 0,
          shift_duration_remaining_seconds: remainingShiftSeconds, // ✅ Restore remaining time
          
          shift_status: 'on_table',
          shift_ends_at: newShiftEndTime,
          break_started_at: null,
          break_ends_at: null,
          
          last_timer_update: now
        },
        'shift_id = ?',
        [shift.shift_id]
      );

      // ✅ LOG BREAK END
      await this.logTimerEvent({
        session_id: session.session_id,
        entity_type: 'dealer',
        entity_id: dealerId,
        table_id: tableId,
        timer_type: 'break',
        event_type: 'timer_completed',
        total_duration_seconds: shift.break_duration_minutes * 60,
        elapsed_seconds: breakElapsedSeconds,
        remaining_seconds: 0,
        performed_by: userId,
        notes: `Break completed after ${Math.floor(breakElapsedSeconds / 60)}m`
      });

      // ✅ LOG SHIFT RESUME
      await this.logTimerEvent({
        session_id: session.session_id,
        entity_type: 'dealer',
        entity_id: dealerId,
        table_id: tableId,
        timer_type: 'shift',
        event_type: 'timer_resumed',
        total_duration_seconds: remainingShiftSeconds,
        elapsed_seconds: 0,
        remaining_seconds: remainingShiftSeconds,
        performed_by: userId,
        notes: `Shift resumed. Remaining: ${Math.floor(remainingShiftSeconds / 60)}m`
      });

      // Assign back to table
      await db.update('tbl_tables', { dealer_id: dealerId }, 'table_id = ?', [tableId]);

      // Update dealer status
      await db.update('tbl_dealers', { dealer_status: 'on_table' }, 'dealer_id = ?', [dealerId]);

      return {
        success: true,
        dealer_name: dealer.dealer_name,
        remaining_shift_minutes: Math.floor(remainingShiftSeconds / 60),
        shift_ends_at: newShiftEndTime,
        message: `${dealer.dealer_name} resumed. ${Math.floor(remainingShiftSeconds / 60)}m remaining.`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ EXTEND DEALER SHIFT
   * Add extra minutes to remaining time
   */
  async extendDealerShift(dealerId, additionalMinutes = 15, userId) {
    try {
      const session = await tableService.getCurrentSession();
      const shift = await db.select(
        'tbl_dealer_shifts',
        '*',
        'dealer_id = ? AND session_id = ? AND shift_status IN ("on_table", "on_break")',
        [dealerId, session.session_id]
      );

      if (!shift) throw new Error('No active shift found');

      const additionalSeconds = additionalMinutes * 60;
      const now = new Date();

      // Add time to remaining
      const newRemainingSeconds = shift.shift_paused_remaining_seconds + additionalSeconds;
      const newShiftEndsAt = shift.shift_status === 'on_break'
        ? new Date(new Date(shift.break_ends_at).getTime() + additionalSeconds * 1000)
        : new Date(now.getTime() + newRemainingSeconds * 1000);

      await db.update(
        'tbl_dealer_shifts',
        {
          shift_paused_remaining_seconds: newRemainingSeconds,
          shift_duration_remaining_seconds: newRemainingSeconds,
          shift_ends_at: newShiftEndsAt,
          last_timer_update: now
        },
        'shift_id = ?',
        [shift.shift_id]
      );

      // ✅ LOG EXTENSION
      await this.logTimerEvent({
        session_id: session.session_id,
        entity_type: 'dealer',
        entity_id: dealerId,
        table_id: shift.table_id,
        timer_type: 'shift',
        event_type: 'timer_extended',
        total_duration_seconds: newRemainingSeconds,
        elapsed_seconds: 0,
        remaining_seconds: newRemainingSeconds,
        performed_by: userId,
        notes: `Shift extended by ${additionalMinutes} minutes`
      });

      return {
        success: true,
        extended_by_minutes: additionalMinutes,
        new_remaining_minutes: Math.floor(newRemainingSeconds / 60),
        message: `Shift extended by ${additionalMinutes} minutes`
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ LOG TIMER EVENT - FOR AUDIT TRAIL
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
      // Don't throw - logging shouldn't block operations
    }
  }

  /**
   * ✅ GET DEALER SHIFT STATE
   * Returns current countdown state for frontend
   */
  async getDealerShiftState(dealerId, sessionId) {
    try {
      const shift = await db.select(
        'tbl_dealer_shifts',
        '*',
        'dealer_id = ? AND session_id = ? AND shift_status IN ("on_table", "on_break")',
        [dealerId, sessionId]
      );

      if (!shift) return null;

      const now = new Date();

      // Calculate current remaining time
      let remainingSeconds = 0;
      let timeType = 'shift';

      if (shift.shift_status === 'on_table') {
        if (shift.shift_timer_status === 'paused') {
          remainingSeconds = shift.shift_paused_remaining_seconds;
        } else {
          const shiftStartTime = new Date(shift.shift_start_time);
          const elapsedMs = now - shiftStartTime;
          const elapsedSeconds = Math.floor(elapsedMs / 1000);
          remainingSeconds = Math.max(0, shift.shift_duration_remaining_seconds - elapsedSeconds);
        }
      } else if (shift.shift_status === 'on_break') {
        timeType = 'break';
        const breakStartTime = new Date(shift.break_started_at);
        const elapsedMs = now - breakStartTime;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        const breakDurationSeconds = shift.break_duration_minutes * 60;
        remainingSeconds = Math.max(0, breakDurationSeconds - elapsedSeconds);
      }

      return {
        shift_id: shift.shift_id,
        dealer_id: dealerId,
        table_id: shift.table_id,
        shift_status: shift.shift_status,
        timer_status: shift.shift_timer_status,
        time_type: timeType,
        remaining_seconds: remainingSeconds,
        remaining_minutes: Math.ceil(remainingSeconds / 60),
        shift_start_time: shift.shift_start_time,
        last_update: shift.last_timer_update
      };
    } catch (error) {
      throw error;
    }
  }
}

module.exports = new DealerTimerService();