// modules/rakeback/services/rakeback.service.js
// Rakeback Service - Player Rewards with Chip Breakdown
// IMPORTANT:
// Rakeback does NOT block on chip inventory.
// Inventory may go negative. System only tracks movement.

const db = require("../../../config/database");
const cashierService = require("../../cashier/services/cashier.service");
const playerService = require("../../player/services/player.service");

class RakebackService {
  // ==========================================
  // GET RAKEBACK TYPES
  // ==========================================
  async getRakebackTypes() {
    const types = await db.selectAll(
      "tbl_rakeback_types",
      "*",
      "is_active = 1",
      [],
      "ORDER BY type_id ASC"
    );

    return (
      types || [
        {
          type_code: "8hrs_week",
          type_label: "Completed 8hrs in a week",
          default_amount: 3500,
        },
        {
          type_code: "7hrs_week",
          type_label: "Completed 7hrs in a week",
          default_amount: 5000,
        },
        { type_code: "custom", type_label: "Custom Amount", default_amount: 0 },
        { type_code: "other", type_label: "Other", default_amount: 0 },
      ]
    );
  }

  // ==========================================
  // PROCESS RAKEBACK (NON-BLOCKING)
  // ==========================================

async processRakeback(data, userId) {
  // ✅ Guard: User ID required (admin/cashier giving rakeback)
  if (!userId) {
    throw new Error("User ID is required to process rakeback");
  }

  // Validate active session
  const session = await cashierService.getTodaySession();
  if (!session) {
    throw new Error("No active session found");
  }

  // Get player
  const player = await playerService.getPlayer(data.player_id);
  if (!player) {
    throw new Error("Player not found");
  }

  // Validate chip breakdown
  const chipBreakdown = data.chip_breakdown || {};
  if (
    !chipBreakdown.chips_100 &&
    !chipBreakdown.chips_500 &&
    !chipBreakdown.chips_5000 &&
    !chipBreakdown.chips_10000
  ) {
    throw new Error(
      "Chip breakdown is required. Please specify which chips to give."
    );
  }

  // Calculate values
  const chips100 = parseInt(chipBreakdown.chips_100 || 0);
  const chips500 = parseInt(chipBreakdown.chips_500 || 0);
  const chips5000 = parseInt(chipBreakdown.chips_5000 || 0);
  const chips10000 = parseInt(chipBreakdown.chips_10000 || 0);

  const totalChipValue =
    chips100 * 100 +
    chips500 * 500 +
    chips5000 * 5000 +
    chips10000 * 10000;

  const totalChipsCount = chips100 + chips500 + chips5000 + chips10000;

  // Validate declared amount matches chip value
  const declaredAmount = parseFloat(data.amount) || totalChipValue;
  if (Math.abs(declaredAmount - totalChipValue) > 0.01) {
    throw new Error(
      `Chip breakdown value (₹${totalChipValue}) does not match declared amount (₹${declaredAmount})`
    );
  }

  // ✅ NO INVENTORY CHECK - ALLOW NEGATIVE
  // Rakeback is a reward. Cashier gives chips even if short.
  // Discrepancy will show in end-of-day chip reconciliation.

  // Rakeback type
  const rakebackType = data.rakeback_type || "custom";
  const rakebackLabel =
    data.rakeback_type_label || this.getRakebackTypeLabel(rakebackType);

  // Create rakeback record
  const result = await db.insert("tbl_rakeback", {
    session_id: session.session_id,
    player_id: data.player_id,
    rakeback_type: rakebackType,
    rakeback_type_label: rakebackLabel,
    amount: totalChipValue,
    chips_100: chips100,
    chips_500: chips500,
    chips_5000: chips5000,
    chips_10000: chips10000,
    total_chips_given: totalChipsCount,
    notes: data.notes || null,
    recorded_by: userId,
  });

  // ✅ UPDATE CHIP TRACKING - Just increase chips_out (no current inventory deduction)
  await db.update(
    "tbl_daily_sessions",
    {
      chips_100_out: parseInt(session.chips_100_out || 0) + chips100,
      chips_500_out: parseInt(session.chips_500_out || 0) + chips500,
      chips_5000_out: parseInt(session.chips_5000_out || 0) + chips5000,
      chips_10000_out: parseInt(session.chips_10000_out || 0) + chips10000,

      total_chips_out: parseFloat(session.total_chips_out || 0) + totalChipValue,

      total_rakeback_given:
        (parseFloat(session.total_rakeback_given) || 0) + totalChipValue,
    },
    "session_id = ?",
    [session.session_id]
  );

  // Update player's total rakeback received
  await db.query(
    `
    UPDATE tbl_players
    SET total_rakeback_received = COALESCE(total_rakeback_received, 0) + ?
    WHERE player_id = ?
    `,
    [totalChipValue, data.player_id]
  );

  // Log chip movement
  await this.logChipMovement(session.session_id, {
    movement_type: "rakeback",
    direction: "out",
    player_id: data.player_id,
    chip_breakdown: chipBreakdown,
    total_value: totalChipValue,
    notes: `Rakeback (${rakebackLabel}) to ${player.player_name}`,
    created_by: userId,
  });

  return {
    success: true,
    rakeback_id: result.insert_id,
    player_id: data.player_id,
    player_name: player.player_name,
    rakeback_type: rakebackType,
    rakeback_type_label: rakebackLabel,
    amount: totalChipValue,
    chip_breakdown: chipBreakdown,
    total_chips: totalChipsCount,
    message: `Rakeback of ₹${totalChipValue.toLocaleString("en-IN")} (${totalChipsCount} chips) given to ${player.player_name}`,
  };
}

  // ==========================================
  // HELPERS
  // ==========================================
  getRakebackTypeLabel(typeCode) {
    const labels = {
      "8hrs_week": "Completed 8hrs in a week",
      "7hrs_week": "Completed 7hrs in a week",
      custom: "Custom Amount",
      other: "Other",
    };
    return labels[typeCode] || typeCode;
  }

  // ==========================================
  // GET RAKEBACKS FOR SESSION
  // ==========================================
  async getRakebacksForSession(sessionId) {
    const rakebacks = await db.queryAll(
      `
      SELECT r.*, p.player_name, p.player_code
      FROM tbl_rakeback r
      JOIN tbl_players p ON r.player_id = p.player_id
      WHERE r.session_id = ?
      ORDER BY r.created_at DESC
      `,
      [sessionId]
    );

    return rakebacks || [];
  }

  // ==========================================
  // PLAYER RAKEBACK HISTORY
  // ==========================================
  async getPlayerRakebackHistory(playerId) {
    const rakebacks = await db.selectAll(
      "tbl_rakeback",
      "*",
      "player_id = ?",
      [playerId],
      "ORDER BY created_at DESC"
    );

    let total = 0;
    (rakebacks || []).forEach((r) => {
      total += parseFloat(r.amount);
    });

    return {
      rakebacks: rakebacks || [],
      total_rakeback: total,
      count: rakebacks?.length || 0,
    };
  }

  // ==========================================
  // CHIP MOVEMENT LOG
  // ==========================================
  async logChipMovement(sessionId, data) {
    const chipBreakdown = data.chip_breakdown || {};
    const totalChips =
      (chipBreakdown.chips_100 || 0) +
      (chipBreakdown.chips_500 || 0) +
      (chipBreakdown.chips_5000 || 0) +
      (chipBreakdown.chips_10000 || 0);

    await db.insert("tbl_chip_movement_log", {
      session_id: sessionId,
      movement_type: data.movement_type,
      direction: data.direction,
      player_id: data.player_id || null,
      dealer_id: data.dealer_id || null,
      transaction_id: data.transaction_id || null,
      chips_100: chipBreakdown.chips_100 || 0,
      chips_500: chipBreakdown.chips_500 || 0,
      chips_5000: chipBreakdown.chips_5000 || 0,
      chips_10000: chipBreakdown.chips_10000 || 0,
      total_chips: totalChips,
      total_value: data.total_value || 0,
      notes: data.notes || null,
      created_by: data.created_by,
    });
  }
}

module.exports = new RakebackService();
