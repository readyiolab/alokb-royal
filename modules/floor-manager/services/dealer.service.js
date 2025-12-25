// ============================================
// FILE: modules/floor-manager/services/dealer.service.js
// Business logic for dealer management
// ============================================

const db = require('../../../config/database');
const tableService = require('./table.service');

class DealerService {
  /**
   * ✅ GET ALL DEALERS WITH CURRENT STATUS
   * Uses subquery to get only the latest shift per dealer to avoid duplicates
   * Includes all timer fields needed for frontend countdown
   */
  async getAllDealers(sessionId) {
    try {
      const dealers = await db.queryAll(
        `SELECT 
          d.*,
          ds.shift_status,
          ds.table_id as assigned_table_id,
          ds.current_shift_started_at,
          ds.shift_duration_minutes,
          ds.shift_ends_at,
          ds.break_ends_at,
          ds.break_started_at,
          ds.break_duration_minutes,
          ds.shift_paused_remaining_seconds,
          ds.shift_timer_status,
          ds.shift_start_time,
          ds.shift_duration_remaining_seconds,
          t.table_number,
          t.table_name
        FROM tbl_dealers d
        LEFT JOIN (
          SELECT ds1.* FROM tbl_dealer_shifts ds1
          INNER JOIN (
            SELECT dealer_id, MAX(shift_id) as max_shift_id
            FROM tbl_dealer_shifts
            WHERE session_id = ?
            GROUP BY dealer_id
          ) ds2 ON ds1.dealer_id = ds2.dealer_id AND ds1.shift_id = ds2.max_shift_id
        ) ds ON d.dealer_id = ds.dealer_id
        LEFT JOIN tbl_tables t ON ds.table_id = t.table_id
        WHERE d.dealer_status != 'inactive'
        ORDER BY d.dealer_name`,
        [sessionId]
      );

      const now = new Date();

      return (dealers || []).map(dealer => {
        // ✅ Calculate shift remaining time
        let shiftRemainingSeconds = 0;
        let shiftElapsedSeconds = 0;
        
        if (dealer.dealer_status === 'on_table' && dealer.shift_ends_at) {
          const shiftEndsAt = new Date(dealer.shift_ends_at);
          shiftRemainingSeconds = Math.floor((shiftEndsAt - now) / 1000);
          
          // Calculate elapsed from shift start
          const shiftStartTime = dealer.current_shift_started_at || dealer.shift_start_time;
          if (shiftStartTime) {
            shiftElapsedSeconds = Math.floor((now - new Date(shiftStartTime)) / 1000);
          }
        }
        
        // ✅ Calculate break remaining time
        let breakRemainingSeconds = 0;
        if (dealer.dealer_status === 'on_break' && dealer.break_ends_at) {
          const breakEndsAt = new Date(dealer.break_ends_at);
          breakRemainingSeconds = Math.max(0, Math.floor((breakEndsAt - now) / 1000));
        }
        
        return {
          dealer_id: dealer.dealer_id,
          dealer_code: dealer.dealer_code,
          dealer_name: dealer.dealer_name,
          dealer_status: dealer.dealer_status,
          shift_status: dealer.shift_status,
          available: dealer.dealer_status === 'available',
          
          assigned_table: dealer.assigned_table_id ? {
            table_id: dealer.assigned_table_id,
            table_number: dealer.table_number,
            table_name: dealer.table_name
          } : null,
          
          // ✅ TIMER FIELDS for frontend hook
          shift_start_time: dealer.current_shift_started_at || dealer.shift_start_time,
          shift_duration_minutes: dealer.shift_duration_minutes,
          shift_ends_at: dealer.shift_ends_at,
          shift_remaining_seconds: shiftRemainingSeconds,
          shift_elapsed_seconds: shiftElapsedSeconds,
          shift_timer_status: dealer.shift_timer_status,
          
          // ✅ BREAK FIELDS
          break_started_at: dealer.break_started_at,
          break_ends_at: dealer.break_ends_at,
          break_duration_minutes: dealer.break_duration_minutes,
          break_remaining_seconds: breakRemainingSeconds,
          
          // ✅ PAUSED STATE (for resume)
          shift_paused_remaining_seconds: dealer.shift_paused_remaining_seconds || 0,
          
          // ✅ ALERT FLAGS
          is_shift_ending: shiftRemainingSeconds > 0 && shiftRemainingSeconds <= 300, // 5 min warning
          is_shift_overdue: shiftRemainingSeconds <= 0 && dealer.dealer_status === 'on_table'
        };
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ GENERATE UNIQUE DEALER CODE
   */
  async generateDealerCode() {
    const lastDealer = await db.query(
      'SELECT dealer_code FROM tbl_dealers ORDER BY dealer_id DESC LIMIT 1'
    );

    if (!lastDealer || !lastDealer.dealer_code) {
      return 'DL00001';
    }

    const lastNumber = parseInt(lastDealer.dealer_code.replace('DL', ''));
    const newNumber = lastNumber + 1;
    return `DL${String(newNumber).padStart(5, '0')}`;
  }

  /**
   * ✅ CREATE NEW DEALER
   */
  async createDealer(data, userId) {
    try {
      const { dealer_name, phone_number, dealer_email } = data;

      // ✅ Generate unique dealer code
      const dealerCode = await this.generateDealerCode();

      const result = await db.insert('tbl_dealers', {
        dealer_code: dealerCode,  // ✅ Add dealer_code
        dealer_name,
        phone_number: phone_number || null,
        email: dealer_email || null,
        dealer_status: 'available',
        created_at: new Date()
      });

      return {
        dealer_id: result.insert_id,
        dealer_code: dealerCode,  // ✅ Return dealer_code
        dealer_name,
        phone_number: phone_number || null,
        message: 'Dealer created successfully'
      };
    } catch (error) {
      throw error;
    }
  }

  /**
 * ✅ GET DEALER BY ID (for audit logs)
 */
  async getDealerById(dealerId) {
    try {
      const dealer = await db.select(
        'tbl_dealers',
        '*',
        'dealer_id = ?',
        [dealerId]
      );
      return dealer;
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ SEND DEALER ON BREAK
   */
  async sendDealerOnBreak(dealerId, userId) {
    try {
      const dealer = await db.select(
        'tbl_dealers',
        '*',
        'dealer_id = ?',
        [dealerId]
      );

      if (!dealer) {
        throw new Error('Dealer not found');
      }

      const session = await tableService.getCurrentSession();

      // Find current shift
      const shift = await db.select(
        'tbl_dealer_shifts',
        '*',
        'dealer_id = ? AND session_id = ? AND shift_status = "on_table"',
        [dealerId, session.session_id]
      );

      if (!shift) {
        throw new Error('Dealer is not on table');
      }

      const tableId = shift.table_id; // ✅ Store table ID for auto-assignment

      const breakDuration = 15; // 15 minutes
      const breakStartedAt = new Date();
      const breakEndsAt = new Date(breakStartedAt.getTime() + breakDuration * 60 * 1000);

      // Update shift
      await db.update(
        'tbl_dealer_shifts',
        {
          shift_status: 'on_break',
          break_started_at: breakStartedAt,
          break_duration_minutes: breakDuration,
          break_ends_at: breakEndsAt
        },
        'shift_id = ?',
        [shift.shift_id]
      );

      // Update dealer status
      await db.update(
        'tbl_dealers',
        { dealer_status: 'on_break' },
        'dealer_id = ?',
        [dealerId]
      );

      // Remove from table
      await db.update(
        'tbl_tables',
        { dealer_id: null },
        'table_id = ?',
        [shift.table_id]
      );

      // ✅ AUTO-ASSIGN ANOTHER DEALER
      let availableDealer = null;
      try {
        availableDealer = await db.select(
          'tbl_dealers',
          '*',
          'dealer_status = "available" ORDER BY RAND() LIMIT 1'
        );

        if (availableDealer) {
          await tableService.assignDealerToTable(
            tableId,
            availableDealer.dealer_id,
            userId
          );
        }
      } catch (assignError) {
        console.log('No available dealer to auto-assign:', assignError.message);
      }

      return {
        success: true,
        break_ends_at: breakEndsAt,
        auto_assigned_new_dealer: !!availableDealer,
        new_dealer_name: availableDealer?.dealer_name || null,
        message: `${dealer.dealer_name} sent on break${availableDealer ? `. ${availableDealer.dealer_name} assigned to table.` : ''}`
      };

    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ MARK DEALER AS AVAILABLE (After break)
   */
  async markDealerAvailable(dealerId, userId) {
    try {
      await db.update(
        'tbl_dealers',
        { dealer_status: 'available' },
        'dealer_id = ?',
        [dealerId]
      );

      const session = await tableService.getCurrentSession();

      // Update shift status
      await db.update(
        'tbl_dealer_shifts',
        {
          shift_status: 'available',
          break_started_at: null,
          break_ends_at: null
        },
        'dealer_id = ? AND session_id = ? AND shift_status = "on_break"',
        [dealerId, session.session_id]
      );

      return {
        success: true,
        message: 'Dealer marked as available'
      };
    } catch (error) {
      throw error;
    }
  }
}

module.exports = new DealerService();