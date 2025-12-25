// modules/cashier/services/cashier.service.js
// ✅ FIXED VERSION - Proper Chip Tracking System

const db = require("../../../config/database");

class CashierService {
  /**
   * ✅ ADD CASH FLOAT (Mali) - Can be called MULTIPLE TIMES per day
   * Records each addition separately with tracking
   */
  async addCashFloat(data, userId) {
    const session = await this.getTodaySession();

    if (!session) {
      throw new Error("No active session found");
    }

    if (session.is_closed) {
      throw new Error("Cannot add float to a closed session");
    }

    const cashAmount = parseFloat(data.amount);
    if (!cashAmount || cashAmount <= 0) {
      throw new Error("Invalid cash amount");
    }

    // ✅ FIX: Calculate chip value CORRECTLY
    let chipValue = 0;
    let chipBreakdown = null;

    if (data.chip_breakdown) {
      chipBreakdown = {
        chips_100: parseInt(data.chip_breakdown.chips_100 || 0),
        chips_500: parseInt(data.chip_breakdown.chips_500 || 0),
        chips_5000: parseInt(data.chip_breakdown.chips_5000 || 0),
        chips_10000: parseInt(data.chip_breakdown.chips_10000 || 0),
      };

      // ✅ CORRECT CALCULATION: Each denomination × its value
      chipValue =
        chipBreakdown.chips_100 * 100 +
        chipBreakdown.chips_500 * 500 +
        chipBreakdown.chips_5000 * 5000 +
        chipBreakdown.chips_10000 * 10000;

      console.log(`💰 Chip breakdown: `, chipBreakdown);
      console.log(`💰 Calculated chip value: ₹${chipValue}`);
      console.log(`💰 Cash amount entered: ₹${cashAmount}`);

      // Validate chip breakdown matches cash if chips provided
      if (chipValue > 0 && Math.abs(chipValue - cashAmount) > 1) {
        throw new Error(
          `Chip value ₹${chipValue.toLocaleString(
            "en-IN"
          )} doesn't match cash amount ₹${cashAmount.toLocaleString("en-IN")}`
        );
      }
    }

    // ✅ Get user name for display
    const user = await db.select(
      "tbl_users",
      "username, full_name",
      "user_id = ?",
      [userId]
    );
    const adminName = user?.full_name || user?.username || "Admin";

    // ✅ STEP 1: Record in tbl_session_float_additions
    const additionResult = await db.insert("tbl_session_float_additions", {
      session_id: session.session_id,
      float_amount: cashAmount,
      chips_100: chipBreakdown?.chips_100 || 0,
      chips_500: chipBreakdown?.chips_500 || 0,
      chips_5000: chipBreakdown?.chips_5000 || 0,
      chips_10000: chipBreakdown?.chips_10000 || 0,
      addition_type: chipValue > 0 ? "cash_with_chips" : "cash_only",
      reason:
        data.reason || data.notes || "Additional float (mali) added to session",
      added_by: userId,
      created_at: new Date(),
    });

    // ✅ STEP 2: Record as transaction
    await db.insert("tbl_transactions", {
      session_id: session.session_id,
      transaction_type: "add_float",
      player_id: null,
      player_name: `${adminName} (Float Addition)`,
      amount: cashAmount,
      chips_amount: chipValue,
      payment_mode: "cash",
      wallet_used: "primary",
      primary_amount: cashAmount,
      secondary_amount: 0,
      chips_100: chipBreakdown?.chips_100 || 0,
      chips_500: chipBreakdown?.chips_500 || 0,
      chips_5000: chipBreakdown?.chips_5000 || 0,
      chips_10000: chipBreakdown?.chips_10000 || 0,
      notes:
        data.reason ||
        data.notes ||
        `Float addition: ₹${cashAmount.toLocaleString("en-IN")}`,
      created_by: userId,
      created_at: new Date(),
    });

    // ✅ STEP 3: Update session wallets and chip inventory
    const currentPrimaryWallet = parseFloat(session.primary_wallet || 0);
    const currentOwnerFloat = parseFloat(session.owner_float || 0);
    const currentOpeningFloat = parseFloat(session.opening_float || 0);
    const totalAdditions =
      parseFloat(session.total_float_additions || 0) + cashAmount;
    const additionCount = parseInt(session.float_addition_count || 0) + 1;

    await db.update(
      "tbl_daily_sessions",
      {
        primary_wallet: currentPrimaryWallet + cashAmount,
        owner_float: currentOwnerFloat + cashAmount,
        opening_float: currentOpeningFloat + cashAmount,
        total_float_additions: totalAdditions,
        float_addition_count: additionCount,
        last_float_addition_at: new Date(),
      },
      "session_id = ?",
      [session.session_id]
    );

    // ✅ Add chips to inventory if provided
    if (chipBreakdown && chipValue > 0) {
      await db.update(
        "tbl_daily_sessions",
        {
          chips_100_opening:
            parseInt(session.chips_100_opening || 0) + chipBreakdown.chips_100,
          chips_500_opening:
            parseInt(session.chips_500_opening || 0) + chipBreakdown.chips_500,
          chips_5000_opening:
            parseInt(session.chips_5000_opening || 0) +
            chipBreakdown.chips_5000,
          chips_10000_opening:
            parseInt(session.chips_10000_opening || 0) +
            chipBreakdown.chips_10000,
          chips_100_current:
            parseInt(session.chips_100_current || 0) + chipBreakdown.chips_100,
          chips_500_current:
            parseInt(session.chips_500_current || 0) + chipBreakdown.chips_500,
          chips_5000_current:
            parseInt(session.chips_5000_current || 0) +
            chipBreakdown.chips_5000,
          chips_10000_current:
            parseInt(session.chips_10000_current || 0) +
            chipBreakdown.chips_10000,
        },
        "session_id = ?",
        [session.session_id]
      );
    }

    return {
      addition_id: additionResult.insert_id,
      success: true,
      amount_added: cashAmount,
      chips_added: chipValue,
      chip_breakdown: chipBreakdown,
      new_primary_wallet: currentPrimaryWallet + cashAmount,
      total_additions_today: totalAdditions,
      addition_count: additionCount,
      added_by: adminName,
      message:
        `Float addition #${additionCount} by ${adminName}: Added ₹${cashAmount.toLocaleString(
          "en-IN"
        )}` +
        (chipValue > 0
          ? ` with ₹${chipValue.toLocaleString("en-IN")} in chips`
          : "") +
        `. Total additions today: ₹${totalAdditions.toLocaleString("en-IN")}`,
    };
  }

  /**
   * ✅ Get count of float additions for today's session
   */
  async getFloatAdditionCount(sessionId) {
    const result = await db.query(
      "SELECT COUNT(*) as count FROM tbl_session_float_additions WHERE session_id = ?",
      [sessionId]
    );
    return result?.count || 0;
  }

  /**
   * Get float addition history for session
   */
  async getFloatAdditionHistory(sessionId) {
    const additions = await db.selectAll(
      "tbl_session_float_additions",
      "*",
      "session_id = ?",
      [sessionId],
      "ORDER BY created_at DESC"
    );

    // Calculate totals
    let totalCash = 0;
    let totalChips = 0;

    (additions || []).forEach((addition) => {
      totalCash += parseFloat(addition.float_amount || 0);
      const chipValue =
        parseInt(addition.chips_100 || 0) * 100 +
        parseInt(addition.chips_500 || 0) * 500 +
        parseInt(addition.chips_5000 || 0) * 5000 +
        parseInt(addition.chips_10000 || 0) * 10000;
      totalChips += chipValue;
    });

    return {
      additions: additions || [],
      summary: {
        total_additions: (additions || []).length,
        total_cash_added: totalCash,
        total_chips_added: totalChips,
        total_value: totalCash,
      },
    };
  }

  /**
   * Get detailed float summary for today's session
   */
  async getFloatSummary(sessionId) {
    const session = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_id = ?",
      [sessionId]
    );

    if (!session) {
      throw new Error("Session not found");
    }

    const additionsHistory = await this.getFloatAdditionHistory(sessionId);

    return {
      session_id: session.session_id,
      session_date: session.session_date,

      // Initial float (when session opened)
      initial_owner_float:
        parseFloat(session.opening_float || 0) -
        parseFloat(session.total_float_additions || 0),

      // Float additions
      total_float_additions: parseFloat(session.total_float_additions || 0),
      float_addition_count: parseInt(session.float_addition_count || 0),
      last_addition_at: session.last_float_addition_at,

      // Current state
      current_owner_float: parseFloat(session.owner_float || 0),
      current_primary_wallet: parseFloat(session.primary_wallet || 0),

      // Detailed additions
      additions: additionsHistory.additions,
      additions_summary: additionsHistory.summary,
    };
  }

  async setChipInventory(chipInventory, userId) {
    const session = await this.getTodaySession();

    if (session.chip_inventory_set === 1) {
      throw new Error(
        "Chip inventory already set. Cannot modify after transactions begin."
      );
    }

    if (!chipInventory || typeof chipInventory !== "object") {
      throw new Error("Invalid chip inventory data");
    }

    const inventory = {
      chips_100: parseInt(chipInventory.chips_100) || 0,
      chips_500: parseInt(chipInventory.chips_500) || 0,
      chips_5000: parseInt(chipInventory.chips_5000) || 0,
      chips_10000: parseInt(chipInventory.chips_10000) || 0,
    };

    if (
      inventory.chips_100 < 0 ||
      inventory.chips_500 < 0 ||
      inventory.chips_5000 < 0 ||
      inventory.chips_10000 < 0
    ) {
      throw new Error("Chip counts cannot be negative");
    }

    const totalChipValue =
      inventory.chips_100 * 100 +
      inventory.chips_500 * 500 +
      inventory.chips_5000 * 5000 +
      inventory.chips_10000 * 10000;

    const totalChipCount =
      inventory.chips_100 +
      inventory.chips_500 +
      inventory.chips_5000 +
      inventory.chips_10000;

    const ownerFloat = parseFloat(session.owner_float);
    if (totalChipValue > ownerFloat) {
      throw new Error(
        `Chip inventory value (₹${totalChipValue.toLocaleString(
          "en-IN"
        )}) cannot exceed owner's float (₹${ownerFloat.toLocaleString(
          "en-IN"
        )}).`
      );
    }

    const updates = {
      chip_inventory_set: 1,
      chips_100_opening: inventory.chips_100,
      chips_500_opening: inventory.chips_500,
      chips_5000_opening: inventory.chips_5000,
      chips_10000_opening: inventory.chips_10000,
      chips_100_current: inventory.chips_100,
      chips_500_current: inventory.chips_500,
      chips_5000_current: inventory.chips_5000,
      chips_10000_current: inventory.chips_10000,
      chips_100_out: 0,
      chips_500_out: 0,
      chips_5000_out: 0,
      chips_10000_out: 0,
      total_chips_out: 0,
    };

    await db.update("tbl_daily_sessions", updates, "session_id = ?", [
      session.session_id,
    ]);

    return {
      success: true,
      session_id: session.session_id,
      chip_inventory: {
        chips_100: inventory.chips_100,
        chips_500: inventory.chips_500,
        chips_5000: inventory.chips_5000,
        chips_10000: inventory.chips_10000,
        total_chips: totalChipCount,
        total_value: totalChipValue,
      },
      message: `Chip inventory set: ${totalChipCount} chips (₹${totalChipValue.toLocaleString(
        "en-IN"
      )})`,
    };
  }

  async updateChipInventory(sessionId, chipBreakdown, isGivingOut = true) {
    const session = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_id = ?",
      [sessionId]
    );

    const chips_100_change = parseInt(chipBreakdown.chips_100) || 0;
    const chips_500_change = parseInt(chipBreakdown.chips_500) || 0;
    const chips_5000_change = parseInt(chipBreakdown.chips_5000) || 0;
    const chips_10000_change = parseInt(chipBreakdown.chips_10000) || 0;

    const totalValue =
      chips_100_change * 100 +
      chips_500_change * 500 +
      chips_5000_change * 5000 +
      chips_10000_change * 10000;

    let updates = {};

    if (isGivingOut) {
      updates = {
        chips_100_current:
          parseInt(session.chips_100_current) - chips_100_change,
        chips_500_current:
          parseInt(session.chips_500_current) - chips_500_change,
        chips_5000_current:
          parseInt(session.chips_5000_current) - chips_5000_change,
        chips_10000_current:
          parseInt(session.chips_10000_current) - chips_10000_change,

        chips_100_out: parseInt(session.chips_100_out) + chips_100_change,
        chips_500_out: parseInt(session.chips_500_out) + chips_500_change,
        chips_5000_out: parseInt(session.chips_5000_out) + chips_5000_change,
        chips_10000_out: parseInt(session.chips_10000_out) + chips_10000_change,
      };

      if (
        updates.chips_100_current < 0 ||
        updates.chips_500_current < 0 ||
        updates.chips_5000_current < 0 ||
        updates.chips_10000_current < 0
      ) {
        const shortages = [];
        if (updates.chips_100_current < 0) {
          shortages.push(
            `₹100: need ${chips_100_change}, have ${session.chips_100_current}`
          );
        }
        if (updates.chips_500_current < 0) {
          shortages.push(
            `₹500: need ${chips_500_change}, have ${session.chips_500_current}`
          );
        }
        if (updates.chips_5000_current < 0) {
          shortages.push(
            `₹5000: need ${chips_5000_change}, have ${session.chips_5000_current}`
          );
        }
        if (updates.chips_10000_current < 0) {
          shortages.push(
            `₹10000: need ${chips_10000_change}, have ${session.chips_10000_current}`
          );
        }

        throw new Error(`Insufficient chips: ${shortages.join(", ")}`);
      }
    } else {
      updates = {
        chips_100_current:
          parseInt(session.chips_100_current) + chips_100_change,
        chips_500_current:
          parseInt(session.chips_500_current) + chips_500_change,
        chips_5000_current:
          parseInt(session.chips_5000_current) + chips_5000_change,
        chips_10000_current:
          parseInt(session.chips_10000_current) + chips_10000_change,

        chips_100_out: Math.max(
          0,
          parseInt(session.chips_100_out) - chips_100_change
        ),
        chips_500_out: Math.max(
          0,
          parseInt(session.chips_500_out) - chips_500_change
        ),
        chips_5000_out: Math.max(
          0,
          parseInt(session.chips_5000_out) - chips_5000_change
        ),
        chips_10000_out: Math.max(
          0,
          parseInt(session.chips_10000_out) - chips_10000_change
        ),
      };

      const hasNegativeOut =
        updates.chips_100_out < 0 ||
        updates.chips_500_out < 0 ||
        updates.chips_5000_out < 0 ||
        updates.chips_10000_out < 0;

      if (hasNegativeOut) {
        console.warn(
          `Chip inventory: Negative chips_out detected (house profit from player winnings)`
        );
      }
    }

    await db.update("tbl_daily_sessions", updates, "session_id = ?", [
      sessionId,
    ]);

    return {
      success: true,
      updates: updates,
    };
  }

  validateChipBreakdown(chipBreakdown, expectedAmount) {
    const calculatedAmount =
      (chipBreakdown.chips_100 || 0) * 100 +
      (chipBreakdown.chips_500 || 0) * 500 +
      (chipBreakdown.chips_5000 || 0) * 5000 +
      (chipBreakdown.chips_10000 || 0) * 10000;

    if (calculatedAmount !== expectedAmount) {
      throw new Error(
        `Chip breakdown (₹${calculatedAmount}) doesn't match amount (₹${expectedAmount}).`
      );
    }

    return true;
  }

  /**
   * ✅ START DAILY SESSION with chip inventory (Cashier)
   * Creates a new session or reopens a closed one with new float and chip inventory
   */
  async startDailySession(ownerFloat, chipInventory, userId) {
    const today = new Date().toISOString().split("T")[0];

    // Check if there's already an active session for today
    const existingActiveSession = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_date = ? AND is_closed = 0",
      [today]
    );

    if (existingActiveSession) {
      throw new Error("Session already opened for today. Close it first to start a new one.");
    }

    // Default chip inventory if not provided
    const chips = chipInventory || {
      chips_100: 0,
      chips_500: 0,
      chips_5000: 0,
      chips_10000: 0,
    };

    // Calculate total chip value
    const totalChipValue =
      (parseInt(chips.chips_100) || 0) * 100 +
      (parseInt(chips.chips_500) || 0) * 500 +
      (parseInt(chips.chips_5000) || 0) * 5000 +
      (parseInt(chips.chips_10000) || 0) * 10000;

    const totalChipCount =
      (parseInt(chips.chips_100) || 0) +
      (parseInt(chips.chips_500) || 0) +
      (parseInt(chips.chips_5000) || 0) +
      (parseInt(chips.chips_10000) || 0);

    // Check if there's a closed session for today - if so, reopen it
    const closedSession = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_date = ? AND is_closed = 1",
      [today]
    );

    let sessionId;

    if (closedSession) {
      // ✅ REOPEN the closed session with new values
      await db.update(
        "tbl_daily_sessions",
        {
          owner_float: ownerFloat,
          opening_float: ownerFloat,
          closing_float: 0,

          // Reset chip inventory
          chips_100_opening: chips.chips_100 || 0,
          chips_500_opening: chips.chips_500 || 0,
          chips_5000_opening: chips.chips_5000 || 0,
          chips_10000_opening: chips.chips_10000 || 0,

          chips_100_current: chips.chips_100 || 0,
          chips_500_current: chips.chips_500 || 0,
          chips_5000_current: chips.chips_5000 || 0,
          chips_10000_current: chips.chips_10000 || 0,

          chips_100_out: 0,
          chips_500_out: 0,
          chips_5000_out: 0,
          chips_10000_out: 0,

          // Reset wallets
          primary_wallet: ownerFloat,
          secondary_wallet: 0,
          secondary_wallet_deposits: 0,
          secondary_wallet_withdrawals: 0,

          // Reset totals
          total_deposits: 0,
          total_withdrawals: 0,
          total_expenses: 0,
          total_chips_out: 0,
          outstanding_credit: 0,
          total_float_additions: 0,
          float_addition_count: 0,

          // Reopen session
          is_closed: 0,
          closed_by: null,
          closed_at: null,
          chip_inventory_set: totalChipCount > 0 ? 1 : 0,
          opened_by: userId,
          opened_at: new Date(),
        },
        "session_id = ?",
        [closedSession.session_id]
      );

      sessionId = closedSession.session_id;
      console.log(`✅ Session #${sessionId} reopened for ${today}`);
    } else {
      // ✅ Create new session (first session of the day)
      const result = await db.insert("tbl_daily_sessions", {
        session_date: today,
        owner_float: ownerFloat,
        opening_float: ownerFloat,
        closing_float: 0,

        // Chip Inventory
        chips_100_opening: chips.chips_100 || 0,
        chips_500_opening: chips.chips_500 || 0,
        chips_5000_opening: chips.chips_5000 || 0,
        chips_10000_opening: chips.chips_10000 || 0,

        chips_100_current: chips.chips_100 || 0,
        chips_500_current: chips.chips_500 || 0,
        chips_5000_current: chips.chips_5000 || 0,
        chips_10000_current: chips.chips_10000 || 0,

        chips_100_out: 0,
        chips_500_out: 0,
        chips_5000_out: 0,
        chips_10000_out: 0,

        // Primary Wallet (Owner's Cash Float)
        primary_wallet: ownerFloat,

        // Secondary Wallet (Player Deposits)
        secondary_wallet: 0,
        secondary_wallet_deposits: 0,
        secondary_wallet_withdrawals: 0,

        total_deposits: 0,
        total_withdrawals: 0,
        total_expenses: 0,
        total_chips_out: 0,
        outstanding_credit: 0,
        total_float_additions: 0,
        float_addition_count: 0,
        is_closed: 0,
        chip_inventory_set: totalChipCount > 0 ? 1 : 0,
        cashier_credit_limit: 100000,
        opened_by: userId,
        opened_at: new Date(),
      });

      sessionId = result.insert_id;
      console.log(`✅ New session #${sessionId} created for ${today}`);
    }

    return {
      session_id: sessionId,
      session_date: today,
      owner_float: ownerFloat,
      opening_float: ownerFloat,
      chip_inventory: {
        chips_100: chips.chips_100 || 0,
        chips_500: chips.chips_500 || 0,
        chips_5000: chips.chips_5000 || 0,
        chips_10000: chips.chips_10000 || 0,
        total_chips: totalChipCount,
        total_value: totalChipValue,
      },
      message: `Session started with ₹${ownerFloat.toLocaleString("en-IN")} float` +
        (totalChipCount > 0 ? ` and ${totalChipCount} chips (₹${totalChipValue.toLocaleString("en-IN")})` : ""),
    };
  }

  async getTodaySession() {
    const today = new Date().toISOString().split("T")[0];

    // ✅ FIX: Only get OPEN sessions (not closed) - DO NOT auto-create
    const session = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_date = ? AND is_closed = 0",
      [today]
    );

    // Return null if no active session - let cashier start one manually
    return session || null;
  }

  async closeDailySession(userId) {
    const session = await this.getTodaySession();

    if (session.is_closed) {
      throw new Error("Session already closed");
    }

    const dashboardData = await this.getDashboardData();

    if (dashboardData.pending_credit_requests.length > 0) {
      throw new Error(
        `Cannot close session. ${dashboardData.pending_credit_requests.length} pending credit requests.`
      );
    }

    const warnings = [];

    if (dashboardData.chips_in_circulation > 0) {
      warnings.push(
        `${dashboardData.chips_in_circulation} chips still with players`
      );
    }

    if (dashboardData.outstanding_credit > 0) {
      warnings.push(`₹${dashboardData.outstanding_credit} outstanding credit`);
    }

    const finalPrimaryBalance = dashboardData.wallets.primary.current;
    const finalSecondaryBalance = dashboardData.wallets.secondary.current;
    const totalClosingBalance = finalPrimaryBalance + finalSecondaryBalance;
    const netProfitLoss =
      totalClosingBalance - parseFloat(session.opening_float);

    const playerCount = await db.query(
      "SELECT COUNT(DISTINCT player_id) as count FROM tbl_transactions WHERE session_id = ? AND player_id IS NOT NULL",
      [session.session_id]
    );

    await db.update(
      "tbl_daily_sessions",
      {
        closing_float: totalClosingBalance,
        is_closed: 1,
        closed_by: userId,
        closed_at: new Date(),
      },
      "session_id = ?",
      [session.session_id]
    );

    await db.insert("tbl_session_summaries", {
      session_id: session.session_id,
      session_date: session.session_date,
      owner_float: session.owner_float,
      opening_float: session.opening_float,
      closing_float: totalClosingBalance,

      total_deposits: dashboardData.totals.deposits,
      total_cash_deposits:
        dashboardData.transactions.stats.buy_ins.cash +
        dashboardData.transactions.stats.credit_settled.cash,
      total_online_deposits:
        dashboardData.transactions.stats.buy_ins.online +
        dashboardData.transactions.stats.credit_settled.online,
      total_withdrawals: dashboardData.totals.withdrawals,
      total_expenses: dashboardData.totals.expenses,
      total_float_additions: dashboardData.totals.float_additions,

      chips_in_circulation: dashboardData.chips_in_circulation,
      outstanding_credit: dashboardData.outstanding_credit,
      net_profit_loss: netProfitLoss,

      total_players: playerCount?.count || 0,
      total_transactions: dashboardData.transactions.all.length,

      closed_by: userId,
      closed_at: new Date(),
      summary_data: JSON.stringify({
        chip_inventory: dashboardData.chip_inventory,
        wallets: dashboardData.wallets,
        float_summary: dashboardData.float_summary,
        stats: dashboardData.transactions.stats,
        warnings: warnings,
      }),
    });

    return {
      success: true,
      session: {
        session_id: session.session_id,
        session_date: session.session_date,
        is_closed: 1,
      },
      financial: {
        opening_float: parseFloat(session.opening_float),
        total_float_additions: dashboardData.totals.float_additions,
        closing_balance: totalClosingBalance,
        net_profit_loss: netProfitLoss,
        primary_wallet_final: finalPrimaryBalance,
        secondary_wallet_final: finalSecondaryBalance,
      },
      chip_inventory: dashboardData.chip_inventory,
      float_additions: dashboardData.float_summary,
      activity: {
        total_deposits: dashboardData.totals.deposits,
        total_withdrawals: dashboardData.totals.withdrawals,
        total_expenses: dashboardData.totals.expenses,
        total_players: playerCount?.count || 0,
        total_transactions: dashboardData.transactions.all.length,
      },
      status: {
        chips_in_circulation: dashboardData.chips_in_circulation,
        outstanding_credit: dashboardData.outstanding_credit,
      },
      warnings: warnings.length > 0 ? warnings : null,
    };
  }

  /**
   * ✅ Helper: Get human-readable chip inventory status
   */
  async getChipInventoryStatus(sessionId) {
    const session = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_id = ?",
      [sessionId]
    );

    const inHand = {
      chips_100: parseInt(session.chips_100_current),
      chips_500: parseInt(session.chips_500_current),
      chips_5000: parseInt(session.chips_5000_current),
      chips_10000: parseInt(session.chips_10000_current),
    };

    const withPlayers = {
      chips_100: parseInt(session.chips_100_out),
      chips_500: parseInt(session.chips_500_out),
      chips_5000: parseInt(session.chips_5000_out),
      chips_10000: parseInt(session.chips_10000_out),
    };

    const opening = {
      chips_100: parseInt(session.chips_100_opening),
      chips_500: parseInt(session.chips_500_opening),
      chips_5000: parseInt(session.chips_5000_opening),
      chips_10000: parseInt(session.chips_10000_opening),
    };

    // Calculate totals
    const inHandTotal =
      inHand.chips_100 * 100 +
      inHand.chips_500 * 500 +
      inHand.chips_5000 * 5000 +
      inHand.chips_10000 * 10000;

    const withPlayersTotal =
      withPlayers.chips_100 * 100 +
      withPlayers.chips_500 * 500 +
      withPlayers.chips_5000 * 5000 +
      withPlayers.chips_10000 * 10000;

    const openingTotal =
      opening.chips_100 * 100 +
      opening.chips_500 * 500 +
      opening.chips_5000 * 5000 +
      opening.chips_10000 * 10000;

    const expectedInHand = openingTotal - withPlayersTotal;
    const discrepancy = inHandTotal - expectedInHand;

    return {
      in_hand: { ...inHand, total_value: inHandTotal },
      with_players: { ...withPlayers, total_value: withPlayersTotal },
      opening: { ...opening, total_value: openingTotal },
      analysis: {
        expected_in_hand: expectedInHand,
        actual_in_hand: inHandTotal,
        discrepancy: discrepancy,
        status:
          discrepancy === 0
            ? "✅ Balanced"
            : discrepancy > 0
            ? "⚠️ Extra chips in hand"
            : "⚠️ Missing chips",
        note:
          withPlayersTotal < 0
            ? `Negative chips_out (${withPlayersTotal}) indicates house profit - players returned more than received`
            : null,
      },
    };
  }

  /**
   * Get chip adjustment history for today's session
   */
  async getChipAdjustmentHistory() {
    const session = await this.getTodaySession();

    const adjustments = await db.selectAll(
      "tbl_chip_adjustments",
      "*",
      "session_id = ?",
      [session.session_id],
      "ORDER BY adjusted_at DESC"
    );

    return adjustments || [];
  }

  async validateChipInventorySet() {
    // ✅ REMOVED: No longer require chip inventory to be set first
    // Cashier can work with any chips they have
    return true;
  }

  /**
   * Open daily session with chip inventory
   */
  async openDailySession(ownerFloat, chipInventory, userId) {
    const today = new Date().toISOString().split("T")[0];

    // Check if session already exists
    const existingSession = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_date = ?",
      [today]
    );

    if (existingSession) {
      throw new Error("Session already opened for today");
    }

    // Validate float amount
    if (!ownerFloat || ownerFloat <= 0) {
      throw new Error("Invalid float amount. Must be greater than 0.");
    }

    // Default chip inventory if not provided
    const defaultInventory = {
      chips_100: 100, // 100 chips of ₹100 = ₹10,000
      chips_500: 100, // 100 chips of ₹500 = ₹50,000
      chips_5000: 100, // 100 chips of ₹5000 = ₹5,00,000
      chips_10000: 20, // 20 chips of ₹10,000 = ₹2,00,000
      // Total: 320 chips = ₹7,60,000
    };

    const inventory = chipInventory || defaultInventory;

    // Calculate total chip value
    const totalChipValue =
      inventory.chips_100 * 100 +
      inventory.chips_500 * 500 +
      inventory.chips_5000 * 5000 +
      inventory.chips_10000 * 10000;

    // ✅ FIX: Allow float to be less than total chip value
    // Float is CASH, Chips are PHYSICAL TOKENS with their face value
    // They don't need to match!

    // Create new session with chip tracking
    const result = await db.insert("tbl_daily_sessions", {
      session_date: today,
      owner_float: ownerFloat,
      opening_float: ownerFloat,
      closing_float: 0,

      // Chip Inventory (In Cashier's Hand)
      chips_100_opening: inventory.chips_100,
      chips_500_opening: inventory.chips_500,
      chips_5000_opening: inventory.chips_5000,
      chips_10000_opening: inventory.chips_10000,

      chips_100_current: inventory.chips_100,
      chips_500_current: inventory.chips_500,
      chips_5000_current: inventory.chips_5000,
      chips_10000_current: inventory.chips_10000,

      // Chips with Players (OUT)
      chips_100_out: 0,
      chips_500_out: 0,
      chips_5000_out: 0,
      chips_10000_out: 0,

      // Primary Wallet (Owner's Cash Float)
      primary_wallet: ownerFloat,

      // Secondary Wallet (Player Deposits)
      secondary_wallet: 0,
      secondary_wallet_deposits: 0,
      secondary_wallet_withdrawals: 0,

      total_deposits: 0,
      total_withdrawals: 0,
      total_expenses: 0,
      total_chips_out: 0,
      outstanding_credit: 0,
      is_closed: 0,
      opened_by: userId,
      opened_at: new Date(),
    });

    return {
      session_id: result.insert_id,
      session_date: today,
      opening_float: ownerFloat,
      chip_inventory: {
        chips_100: inventory.chips_100,
        chips_500: inventory.chips_500,
        chips_5000: inventory.chips_5000,
        chips_10000: inventory.chips_10000,
        total_chips:
          inventory.chips_100 +
          inventory.chips_500 +
          inventory.chips_5000 +
          inventory.chips_10000,
        total_value: totalChipValue,
      },
      message: `Session opened with ₹${ownerFloat} float and ${
        inventory.chips_100 +
        inventory.chips_500 +
        inventory.chips_5000 +
        inventory.chips_10000
      } chips (₹${totalChipValue})`,
    };
  }

  /**
   * Get today's active session
   */
  /**
   * ✅ Update chip inventory after transaction
   * @param {number} sessionId
   * @param {object} chipBreakdown - { chips_100: 0, chips_500: 10, chips_5000: 0, chips_10000: 0 }
   * @param {boolean} isGivingOut - true = giving chips to player, false = receiving chips from player
   */
  async updateChipInventory(sessionId, chipBreakdown, isGivingOut = true) {
    const session = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_id = ?",
      [sessionId]
    );

    // Calculate new values
    const chips_100_change = chipBreakdown.chips_100 || 0;
    const chips_500_change = chipBreakdown.chips_500 || 0;
    const chips_5000_change = chipBreakdown.chips_5000 || 0;
    const chips_10000_change = chipBreakdown.chips_10000 || 0;

    let updates = {};

    if (isGivingOut) {
      // ✅ GIVING CHIPS TO PLAYER (Buy-in, Credit)
      // Chips go OUT - just track it, NO inventory restriction
      // Cashier manages their own chips, we just track what's given out

      updates = {
        // ✅ Track chips given out (accumulates)
        chips_100_out: parseInt(session.chips_100_out || 0) + chips_100_change,
        chips_500_out: parseInt(session.chips_500_out || 0) + chips_500_change,
        chips_5000_out:
          parseInt(session.chips_5000_out || 0) + chips_5000_change,
        chips_10000_out:
          parseInt(session.chips_10000_out || 0) + chips_10000_change,

        // ✅ Track total chips out value
        total_chips_out:
          parseFloat(session.total_chips_out || 0) +
          chips_100_change * 100 +
          chips_500_change * 500 +
          chips_5000_change * 5000 +
          chips_10000_change * 10000,
      };

      // ✅ NO INVENTORY CHECK - Cashier manages own chips
      // Just tracking what's given to players
    } else {
      // ✅ RECEIVING CHIPS BACK FROM PLAYER (Cash payout, Return chips)
      // Chips come IN - player may return MORE than given (won from game)

      updates = {
        // ✅ Reduce chips out (what's still with players)
        chips_100_out: Math.max(
          0,
          parseInt(session.chips_100_out || 0) - chips_100_change
        ),
        chips_500_out: Math.max(
          0,
          parseInt(session.chips_500_out || 0) - chips_500_change
        ),
        chips_5000_out: Math.max(
          0,
          parseInt(session.chips_5000_out || 0) - chips_5000_change
        ),
        chips_10000_out: Math.max(
          0,
          parseInt(session.chips_10000_out || 0) - chips_10000_change
        ),

        // ✅ Track chips received back
        chips_100_current:
          parseInt(session.chips_100_current || 0) + chips_100_change,
        chips_500_current:
          parseInt(session.chips_500_current || 0) + chips_500_change,
        chips_5000_current:
          parseInt(session.chips_5000_current || 0) + chips_5000_change,
        chips_10000_current:
          parseInt(session.chips_10000_current || 0) + chips_10000_change,
      };

      // ✅ NO RESTRICTION: Player can return more chips than given (won from others)
    }

    await db.update("tbl_daily_sessions", updates, "session_id = ?", [
      sessionId,
    ]);

    return updates;
  }

  /**
   * Get cashier dashboard with chip tracking
   */

  async getDashboardData() {
    let session;
    try {
      session = await this.getTodaySession();
    } catch (error) {
      session = null;
    }

    // ✅ Handle no active session - return empty dashboard
    if (!session) {
      return {
        session: null,
        has_active_session: false,
        chip_inventory: null,
        chip_inventory_set: false,
        wallets: null,
        float_summary: {
          initial_opening: 0,
          total_additions: 0,
          addition_count: 0,
          total_float: 0,
        },
        transactions: { all: [], stats: {} },
        chips_in_circulation: 0,
        outstanding_credit: 0,
        outstanding_credits: [],
        pending_credit_requests: [],
        totals: {
          deposits: 0,
          withdrawals: 0,
          expenses: 0,
          net_result: 0,
        },
        message: "No active session. Start a new session to begin.",
      };
    }

    const chipInventorySet = session.chip_inventory_set === 1;

    // Fetch all related data
    const [
      transactions,
      dealerTips,
      playerExpenses,
      clubExpenses,
      rakebacks,
      outstandingCredits,
      pendingRequests,
    ] = await Promise.all([
      db.selectAll(
        "tbl_transactions",
        "*",
        "session_id = ?",
        [session.session_id],
        "ORDER BY created_at DESC"
      ),
      db.selectAll(
        "tbl_dealer_tips",
        "*",
        "session_id = ?",
        [session.session_id],
        "ORDER BY created_at DESC"
      ),
      db.selectAll(
        "tbl_player_expenses",
        "*",
        "session_id = ?",
        [session.session_id],
        "ORDER BY created_at DESC"
      ),
      db.selectAll(
        "tbl_club_expenses",
        "*",
        "session_id = ?",
        [session.session_id],
        "ORDER BY created_at DESC"
      ),
      db.selectAll(
        "tbl_rakeback",
        "*",
        "session_id = ?",
        [session.session_id],
        "ORDER BY created_at DESC"
      ),
      db.query(
        `SELECT c.*, p.player_name 
       FROM tbl_credits c
       LEFT JOIN tbl_players p ON c.player_id = p.player_id
       WHERE c.session_id = ? AND c.is_fully_settled = 0`,
        [session.session_id]
      ),
      db.selectAll(
        "tbl_credit_requests",
        "*",
        "session_id = ? AND request_status = ?",
        [session.session_id, "pending"],
        "ORDER BY request_id DESC"
      ),
    ]);

    // Initialize stats
    const stats = {
      buy_ins: { count: 0, total: 0, cash: 0, online: 0 },
      payouts: { count: 0, total: 0, from_secondary: 0, from_primary: 0 },
      credit_issued: { count: 0, total: 0 },
      credit_settled: { count: 0, total: 0, cash: 0, online: 0 },
      expenses: { count: 0, total: 0 },
      chips_returned: { count: 0, total: 0 },
      dealer_tips: { count: 0, total_chips: 0, total_cash_paid: 0 },
      player_expenses: { count: 0, total_chips: 0, total_cash_paid: 0 }, // ✅ ADDED total_cash_paid
      club_expenses: { count: 0, total: 0 },
      rakeback: { count: 0, total: 0 },
    };

    // Process transactions
    (transactions || []).forEach((t) => {
      const amount = parseFloat(t.amount || 0);
      const chips = parseFloat(t.chips_amount || 0);

      switch (t.transaction_type) {
        case "buy_in":
          stats.buy_ins.count++;
          stats.buy_ins.total += amount;
          if (t.payment_mode === "cash") stats.buy_ins.cash += amount;
          else if (t.payment_mode?.startsWith("online_"))
            stats.buy_ins.online += amount;
          break;

        case "cash_payout":
          stats.payouts.count++;
          stats.payouts.total += amount;
          stats.payouts.from_secondary += parseFloat(t.secondary_amount || 0);
          stats.payouts.from_primary += parseFloat(t.primary_amount || 0);
          break;

        case "return_chips":
          stats.chips_returned.count++;
          stats.chips_returned.total += chips;
          break;

        case "issue_credit":
        case "credit_issued":
          stats.credit_issued.count++;
          stats.credit_issued.total += chips;
          break;

        case "settle_credit":
          stats.credit_settled.count++;
          stats.credit_settled.total += amount;
          if (t.payment_mode === "cash") stats.credit_settled.cash += amount;
          else if (t.payment_mode?.startsWith("online_"))
            stats.credit_settled.online += amount;
          break;

        case "expense":
          stats.expenses.count++;
          stats.expenses.total += amount;
          break;
      }
    });

    // Process other expenses
    (dealerTips || []).forEach((tip) => {
      stats.dealer_tips.count++;
      stats.dealer_tips.total_chips += parseFloat(tip.chip_amount || 0);
      stats.dealer_tips.total_cash_paid += parseFloat(
        tip.cash_paid_to_dealer || 0
      );
    });

    (playerExpenses || []).forEach((exp) => {
      stats.player_expenses.count++;
      stats.player_expenses.total_chips += parseFloat(exp.chip_amount || 0);
      stats.player_expenses.total_cash_paid += parseFloat(
        exp.cash_paid_to_vendor || 0
      ); // ✅ ADDED
    });

    (clubExpenses || []).forEach((exp) => {
      stats.club_expenses.count++;
      stats.club_expenses.total += parseFloat(exp.amount || 0);
    });

    (rakebacks || []).forEach((rb) => {
      stats.rakeback.count++;
      stats.rakeback.total += parseFloat(rb.amount || 0);
    });

    // Add non-transaction expenses to total
    stats.expenses.total +=
      stats.dealer_tips.total_cash_paid +
      stats.club_expenses.total +
      stats.player_expenses.total_cash_paid; // ✅ ADDED player expenses cash
    stats.expenses.count += stats.dealer_tips.count + stats.club_expenses.count;

    // ✅ FIXED: Wallet Calculations
    const secondaryDeposits = stats.buy_ins.total + stats.credit_settled.total;
    const secondaryWithdrawals =
      stats.payouts.from_secondary +
      stats.dealer_tips.total_cash_paid +
      stats.club_expenses.total;

    // ✅ CRITICAL FIX: Primary wallet calculation
    // Primary = Initial opening float + Float additions - Withdrawals from primary - Expenses from primary
    const initialOpeningFloat =
      parseFloat(session.opening_float || 0) -
      parseFloat(session.total_float_additions || 0);
    const totalFloatAdditions = parseFloat(session.total_float_additions || 0);

    const primaryWallet = {
  label: "Primary Wallet (Owner Float)",
  initial_opening: initialOpeningFloat,
  float_additions: totalFloatAdditions,
  total_opening: parseFloat(session.opening_float || 0),
  
  // ✅ FIX: Current should be database value (already correct)
  current: parseFloat(session.primary_wallet || 0),
  
  // ✅ FIX: Available = Current (database already tracks this correctly)
  available: parseFloat(session.primary_wallet || 0),
  
  // Tracking purposes only
  paid_in_payouts: stats.payouts.from_primary,
  paid_in_expenses: stats.expenses.total,
};

    const secondaryWallet = {
      label: "Secondary Wallet (Player Deposits)",
      total_received: secondaryDeposits,
      current: secondaryDeposits - secondaryWithdrawals,
      paid_in_payouts: stats.payouts.from_secondary,
      paid_in_dealer_tips: stats.dealer_tips.total_cash_paid,
      paid_in_club_expenses: stats.club_expenses.total,
      expected_balance: secondaryDeposits - secondaryWithdrawals,
    };

    const totalWallet = {
      available: primaryWallet.current + secondaryWallet.current,
      reserved_for_credit: parseFloat(session.outstanding_credit || 0),
      available_for_transactions:
        primaryWallet.current +
        secondaryWallet.current -
        parseFloat(session.outstanding_credit || 0),
    };

    // ✅ Float summary for display
    const floatSummary = {
      initial_opening:
        parseFloat(session.opening_float || 0) -
        parseFloat(session.total_float_additions || 0),
      total_additions: parseFloat(session.total_float_additions || 0),
      addition_count: parseInt(session.float_addition_count || 0),
      total_float: parseFloat(session.opening_float || 0),
      last_addition_at: session.last_addition_at,
    };

    // Chip Inventory (unchanged)
    const calcChipValue = (c100, c500, c5000, c10000) =>
      c100 * 100 + c500 * 500 + c5000 * 5000 + c10000 * 10000;

    const calcChipCount = (c100, c500, c5000, c10000) =>
      c100 + c500 + c5000 + c10000;

    const chipsOut = {
      chips_100: parseInt(session.chips_100_out || 0),
      chips_500: parseInt(session.chips_500_out || 0),
      chips_5000: parseInt(session.chips_5000_out || 0),
      chips_10000: parseInt(session.chips_10000_out || 0),
    };

    const chipInventory = {
      opening: {
        chips_100: parseInt(session.chips_100_opening || 0),
        chips_500: parseInt(session.chips_500_opening || 0),
        chips_5000: parseInt(session.chips_5000_opening || 0),
        chips_10000: parseInt(session.chips_10000_opening || 0),
        total_value: calcChipValue(
          session.chips_100_opening || 0,
          session.chips_500_opening || 0,
          session.chips_5000_opening || 0,
          session.chips_10000_opening || 0
        ),
        total_count: calcChipCount(
          session.chips_100_opening || 0,
          session.chips_500_opening || 0,
          session.chips_5000_opening || 0,
          session.chips_10000_opening || 0
        ),
      },
      current_in_hand: {
        chips_100: parseInt(session.chips_100_current || 0),
        chips_500: parseInt(session.chips_500_current || 0),
        chips_5000: parseInt(session.chips_5000_current || 0),
        chips_10000: parseInt(session.chips_10000_current || 0),
        total_value: calcChipValue(
          session.chips_100_current || 0,
          session.chips_500_current || 0,
          session.chips_5000_current || 0,
          session.chips_10000_current || 0
        ),
        total_count: calcChipCount(
          session.chips_100_current || 0,
          session.chips_500_current || 0,
          session.chips_5000_current || 0,
          session.chips_10000_current || 0
        ),
      },
      with_players: {
        chips_100: Math.max(0, chipsOut.chips_100),
        chips_500: Math.max(0, chipsOut.chips_500),
        chips_5000: Math.max(0, chipsOut.chips_5000),
        chips_10000: Math.max(0, chipsOut.chips_10000),
        total_value: calcChipValue(
          Math.max(0, chipsOut.chips_100),
          Math.max(0, chipsOut.chips_500),
          Math.max(0, chipsOut.chips_5000),
          Math.max(0, chipsOut.chips_10000)
        ),
        total_count: calcChipCount(
          Math.max(0, chipsOut.chips_100),
          Math.max(0, chipsOut.chips_500),
          Math.max(0, chipsOut.chips_5000),
          Math.max(0, chipsOut.chips_10000)
        ),
      },
    };

    // Combine all activities
    const allActivities = [
      ...(transactions || []).map((t) => ({
        ...t,
        activity_type: "transaction",
        display_type: t.transaction_type,
        display_amount: t.amount || t.chips_amount || 0,
        sort_date: new Date(t.created_at),
      })),
      ...(dealerTips || []).map((dt) => ({
        ...dt,
        activity_type: "dealer_tip",
        display_type: "dealer_tip",
        display_amount: dt.chip_amount || dt.cash_paid_to_dealer || 0,
        sort_date: new Date(dt.created_at),
      })),
      ...(rakebacks || []).map((rb) => ({
        ...rb,
        activity_type: "rakeback",
        display_type: "rakeback",
        display_amount: rb.amount || 0,
        sort_date: new Date(rb.created_at),
      })),
      ...(playerExpenses || []).map((pe) => ({
        ...pe,
        activity_type: "player_expense",
        display_type: "player_expense",
        display_amount: pe.chip_amount || 0,
        sort_date: new Date(pe.created_at),
      })),
      ...(clubExpenses || []).map((ce) => ({
        ...ce,
        activity_type: "club_expense",
        display_type: "club_expense",
        display_amount: ce.amount || 0,
        sort_date: new Date(ce.created_at),
      })),
    ].sort((a, b) => b.sort_date - a.sort_date);

    // Final totals
    const deposits = stats.buy_ins.total + stats.credit_settled.total;
    const withdrawals = stats.payouts.total;
    const expenses = stats.expenses.total;

    return {
      session: {
        session_id: session.session_id,
        session_date: session.session_date,
        is_closed: session.is_closed,
        chip_inventory_set: chipInventorySet,
        opened_at: session.opened_at,
      },

      chip_inventory: chipInventory,
      chip_inventory_set: chipInventorySet,

      wallets: {
        primary: primaryWallet,
        secondary: secondaryWallet,
        total: totalWallet,
      },

      float_summary: floatSummary, // ✅ NEW: Separate float tracking

      transactions: {
        all: allActivities,
        regular: transactions || [],
        dealer_tips: dealerTips || [],
        rakebacks: rakebacks || [],
        player_expenses: playerExpenses || [],
        club_expenses: clubExpenses || [],
        stats,
      },

      chips_in_circulation: parseFloat(session.total_chips_out || 0),
      outstanding_credit: parseFloat(session.outstanding_credit || 0),
      outstanding_credits: outstandingCredits || [],
      pending_credit_requests: pendingRequests || [],

      totals: {
        deposits,
        withdrawals,
        expenses,
        net_result: deposits - withdrawals - expenses,
      },
    };
  }

  async getAllSessionSummaries(limit = 30) {
    const summaries = await db.selectAll(
      "tbl_session_summaries",
      "*",
      null,
      null,
      `ORDER BY session_date DESC LIMIT ${limit}`
    );
    return summaries || [];
  }

  async getSessionSummary(sessionId) {
    const summary = await db.select(
      "tbl_session_summaries",
      "*",
      "session_id = ?",
      [sessionId]
    );

    if (!summary) {
      throw new Error("Session summary not found");
    }

    if (summary.summary_data) {
      summary.summary_data = JSON.parse(summary.summary_data);
    }

    return summary;
  }

  async getSessionByDate(date) {
    const session = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_date = ?",
      [date]
    );

    if (!session) {
      throw new Error("Session not found for this date");
    }

    return session;
  }

  async validateTransactionAllowed() {
    try {
      const session = await this.getTodaySession();

      // ✅ Check if session is closed
      if (session.is_closed) {
        throw new Error("Session is closed. No transactions allowed.");
      }

      await this.validateChipInventorySet();
      return true;
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ NEW: Set cashier credit limit for a session
   * Stores the limit so admin can track what limits are set
   */
  async setCreditLimit(sessionId, creditLimit, userId) {
    try {
      // Validate session exists
      const session = await db.select(
        "tbl_daily_sessions",
        "*",
        "session_id = ?",
        [sessionId]
      );

      if (!session) {
        throw new Error("Session not found");
      }

      // Update the session with credit limit
      await db.update(
        "tbl_daily_sessions",
        {
          cashier_credit_limit: creditLimit,
          credit_limit_set_by: userId,
          credit_limit_set_at: new Date(),
        },
        "session_id = ?",
        [sessionId]
      );

      return {
        session_id: sessionId,
        credit_limit: creditLimit,
        set_by_user_id: userId,
        set_at: new Date(),
        message: `Credit limit set to ₹${creditLimit.toLocaleString("en-IN")}`,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ NEW: Get cashier credit limit for a session WITH used amount
   */
  async getCreditLimit(sessionId) {
    try {
      const session = await db.select(
        "tbl_daily_sessions",
        "session_id, cashier_credit_limit, credit_limit_set_by, credit_limit_set_at",
        "session_id = ?",
        [sessionId]
      );

      if (!session) {
        throw new Error("Session not found");
      }

      // Calculate total credit issued (approved requests) for this session
      const approvedRequests = await db.selectAll(
        "tbl_credit_requests",
        "requested_amount",
        "session_id = ? AND request_status = 'approved'",
        [sessionId]
      );

      const totalUsed = (approvedRequests || []).reduce(
        (sum, req) => sum + parseFloat(req.requested_amount || 0),
        0
      );

      const creditLimit = parseFloat(session.cashier_credit_limit || 0);
      const remaining = Math.max(0, creditLimit - totalUsed);

      return {
        session_id: session.session_id,
        credit_limit: creditLimit,
        credit_used: totalUsed,
        credit_remaining: remaining,
        is_exhausted: remaining <= 0,
        is_exceeded: totalUsed > creditLimit,
        exceeded_by: totalUsed > creditLimit ? totalUsed - creditLimit : 0,
        usage_percentage:
          creditLimit > 0 ? Math.round((totalUsed / creditLimit) * 100) : 0,
        set_by_user_id: session.credit_limit_set_by,
        set_at: session.credit_limit_set_at,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * ✅ NEW: Get all credit limit history for all sessions (Admin only)
   */
  async getCreditLimitsHistory() {
    try {
      const sessions = await db.selectAll(
        "tbl_daily_sessions",
        "session_id, session_date, cashier_credit_limit, credit_limit_set_by, credit_limit_set_at, opened_by, is_closed",
        "session_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)",
        [],
        "ORDER BY session_date DESC"
      );

      if (!sessions || sessions.length === 0) {
        return [];
      }

      return sessions.map((session) => ({
        session_id: session.session_id,
        session_date: session.session_date,
        credit_limit: parseFloat(session.cashier_credit_limit || 0),
        set_by_user_id: session.credit_limit_set_by,
        set_at: session.credit_limit_set_at,
        session_opened_by: session.opened_by,
        is_closed: session.is_closed,
      }));
    } catch (error) {
      throw error;
    }
  }

  // ==========================================
  // SESSION FLOAT ADDITION
  // ==========================================

  /**
   * Add additional float during session
   * When cashier needs more chips for payouts
   */
  async addSessionFloat(data, userId) {
    const session = await this.getTodaySession();

    if (!session) {
      throw new Error("No active session found");
    }

    if (session.is_closed) {
      throw new Error("Cannot add float to a closed session");
    }

    const floatAmount = parseFloat(data.float_amount);
    if (!floatAmount || floatAmount <= 0) {
      throw new Error("Invalid float amount");
    }

    // Validate chip breakdown
    const chipBreakdown = data.chip_breakdown || {};
    if (
      !chipBreakdown.chips_100 &&
      !chipBreakdown.chips_500 &&
      !chipBreakdown.chips_5000 &&
      !chipBreakdown.chips_10000
    ) {
      throw new Error("Chip breakdown is required");
    }

    // Calculate chip values
    const chips100 = parseInt(chipBreakdown.chips_100) || 0;
    const chips500 = parseInt(chipBreakdown.chips_500) || 0;
    const chips5000 = parseInt(chipBreakdown.chips_5000) || 0;
    const chips10000 = parseInt(chipBreakdown.chips_10000) || 0;

    const totalChipValue =
      chips100 * 100 + chips500 * 500 + chips5000 * 5000 + chips10000 * 10000;
    const totalChipCount = chips100 + chips500 + chips5000 + chips10000;

    // Validate chip value matches float amount
    if (Math.abs(totalChipValue - floatAmount) > 0.01) {
      throw new Error(
        `Chip value (₹${totalChipValue}) does not match float amount (₹${floatAmount})`
      );
    }

    // Record the float addition
    const result = await db.insert("tbl_session_float_additions", {
      session_id: session.session_id,
      float_amount: floatAmount,
      chips_100: chips100,
      chips_500: chips500,
      chips_5000: chips5000,
      chips_10000: chips10000,
      reason: data.reason || "Additional float for session",
      added_by: userId,
    });

    // Update session
    await db.update(
      "tbl_daily_sessions",
      {
        // Add to primary wallet
        primary_wallet: parseFloat(session.primary_wallet) + floatAmount,
        owner_float: parseFloat(session.owner_float) + floatAmount,

        // Add chips to inventory
        chips_100_current: parseInt(session.chips_100_current) + chips100,
        chips_500_current: parseInt(session.chips_500_current) + chips500,
        chips_5000_current: parseInt(session.chips_5000_current) + chips5000,
        chips_10000_current: parseInt(session.chips_10000_current) + chips10000,

        // Also update opening to reflect correct totals
        chips_100_opening: parseInt(session.chips_100_opening) + chips100,
        chips_500_opening: parseInt(session.chips_500_opening) + chips500,
        chips_5000_opening: parseInt(session.chips_5000_opening) + chips5000,
        chips_10000_opening: parseInt(session.chips_10000_opening) + chips10000,

        // Track additions
        additional_float_amount:
          (parseFloat(session.additional_float_amount) || 0) + floatAmount,
        additional_float_count:
          (parseInt(session.additional_float_count) || 0) + 1,
      },
      "session_id = ?",
      [session.session_id]
    );

    // Log chip movement
    await db.insert("tbl_chip_movement_log", {
      session_id: session.session_id,
      movement_type: "float_addition",
      direction: "in",
      chips_100: chips100,
      chips_500: chips500,
      chips_5000: chips5000,
      chips_10000: chips10000,
      total_chips: totalChipCount,
      total_value: floatAmount,
      notes: data.reason || "Additional float added to session",
      created_by: userId,
    });

    return {
      addition_id: result.insert_id,
      float_amount: floatAmount,
      chip_breakdown: chipBreakdown,
      total_chips: totalChipCount,
      new_primary_wallet: parseFloat(session.primary_wallet) + floatAmount,
      message: `Added ₹${floatAmount} float (${totalChipCount} chips) to session`,
    };
  }

  /**
   * Get float addition history for session
   */
  async getFloatAdditionHistory(sessionId) {
    const additions = await db.selectAll(
      "tbl_session_float_additions",
      "*",
      "session_id = ?",
      [sessionId],
      "ORDER BY created_at DESC"
    );

    return additions || [];
  }

  /**
   * Get chip movement log for session
   */
  async getChipMovementLog(sessionId) {
    const movements = await db.queryAll(
      `
      SELECT 
        m.*,
        p.player_name,
        d.dealer_name
      FROM tbl_chip_movement_log m
      LEFT JOIN tbl_players p ON m.player_id = p.player_id
      LEFT JOIN tbl_dealers d ON m.dealer_id = d.dealer_id
      WHERE m.session_id = ?
      ORDER BY m.created_at DESC
    `,
      [sessionId]
    );

    return movements || [];
  }

  /**
   * Validate if chips are available in inventory
   * ✅ UPDATED: Just return warning, don't block
   */
  async validateChipInventoryAvailable(sessionId, chipBreakdown) {
    const session = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_id = ?",
      [sessionId]
    );

    if (!session) {
      return { available: true, message: "Session auto-created" };
    }

    // ✅ Always return available - cashier manages their own inventory
    return { available: true };
  }
}

module.exports = new CashierService();
