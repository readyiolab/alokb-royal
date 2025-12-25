// modules/transaction/services/transaction.service.js

const db = require("../../../config/database");
const cashierService = require("../../cashier/services/cashier.service");
const playerService = require("../../player/services/player.service");

class TransactionService {
  async getPlayerId(playerData) {
    if (playerData.player_id) {
      return playerData.player_id;
    }

    if (playerData.player_code) {
      const player = await playerService.getPlayer(playerData.player_code);
      return player.player_id;
    }

    if (playerData.phone_number) {
      try {
        const player = await playerService.getPlayerByPhone(
          playerData.phone_number
        );
        return player.player_id;
      } catch (error) {
        if (playerData.player_name) {
          const result = await playerService.createPlayer({
            player_name: playerData.player_name,
            phone_number: playerData.phone_number,
            player_type: "occasional",
          });
          return result.player_id;
        }
      }
    }

    if (playerData.player_name) {
      const result = await playerService.createPlayer({
        player_name: playerData.player_name,
        phone_number: playerData.phone_number || null,
        player_type: "occasional",
      });
      return result.player_id;
    }

    throw new Error("Insufficient player information provided");
  }

  async validateSession() {
    const session = await cashierService.getTodaySession();
    return session;
  }

  async getPlayerChipBalance(playerId, sessionId) {
    let balance = await db.select(
      "tbl_player_chip_balances",
      "*",
      "session_id = ? AND player_id = ?",
      [sessionId, playerId]
    );

    if (!balance) {
      await db.insert("tbl_player_chip_balances", {
        session_id: sessionId,
        player_id: playerId,
        total_chips_received: 0,
        total_chips_returned: 0,
        current_chip_balance: 0,
        stored_chips: 0,
        total_bought_in: 0,
        total_cashed_out: 0,
        total_credit_taken: 0,
        total_credit_settled: 0,
        outstanding_credit: 0,
      });

      balance = await db.select(
        "tbl_player_chip_balances",
        "*",
        "session_id = ? AND player_id = ?",
        [sessionId, playerId]
      );
    }

    // ✅ FETCH REAL outstanding credit from tbl_credits (more reliable)
    // This gets the actual credit_outstanding from credit records that are not fully settled
    const outstandingCreditsRecords = await db.selectAll(
      "tbl_credits",
      "*",
      "session_id = ? AND player_id = ? AND is_fully_settled = 0",
      [sessionId, playerId]
    );

    let realOutstandingCredit = 0;
    if (outstandingCreditsRecords && outstandingCreditsRecords.length > 0) {
      outstandingCreditsRecords.forEach((credit) => {
        realOutstandingCredit += parseFloat(credit.credit_outstanding || 0);
      });
    }

    // ✅ Return balance with REAL outstanding credit from tbl_credits
    return {
      ...balance,
      outstanding_credit: realOutstandingCredit, // Override with real value from tbl_credits
      chips_out: realOutstandingCredit, // For compatibility - some endpoints use chips_out for credit
    };
  }

  async updatePlayerChipBalance(playerId, sessionId, updates) {
    const balance = await this.getPlayerChipBalance(playerId, sessionId);

    const newBalance = {
      total_chips_received:
        parseFloat(balance.total_chips_received) +
        (parseFloat(updates.chips_received) || 0),
      total_chips_returned:
        parseFloat(balance.total_chips_returned) +
        (parseFloat(updates.chips_returned) || 0),
      total_bought_in:
        parseFloat(balance.total_bought_in) +
        (parseFloat(updates.bought_in) || 0),
      total_cashed_out:
        parseFloat(balance.total_cashed_out) +
        (parseFloat(updates.cashed_out) || 0),
      total_credit_taken:
        parseFloat(balance.total_credit_taken) +
        (parseFloat(updates.credit_taken) || 0),
      total_credit_settled:
        parseFloat(balance.total_credit_settled) +
        (parseFloat(updates.credit_settled) || 0),
      outstanding_credit:
        parseFloat(balance.outstanding_credit) +
        (parseFloat(updates.credit_change) || 0),
      stored_chips: parseFloat(
        updates.stored_chips !== undefined
          ? updates.stored_chips
          : balance.stored_chips
      ),
    };

    newBalance.current_chip_balance =
      newBalance.total_chips_received - newBalance.total_chips_returned;

    await db.update(
      "tbl_player_chip_balances",
      newBalance,
      "session_id = ? AND player_id = ?",
      [sessionId, playerId]
    );

    return newBalance;
  }

  async adjustPlayerBalance(data, userId) {
    const session = await this.validateSession();
    const playerId = await this.getPlayerId(data);
    const player = await playerService.getPlayer(playerId);

    const adjustmentAmount = parseFloat(data.adjustment_amount);
    const adjustmentType = data.adjustment_type; // 'winning' or 'loss'
    const reason = data.reason || "Gameplay adjustment";

    if (!adjustmentAmount || adjustmentAmount === 0) {
      throw new Error("Adjustment amount must be greater than 0");
    }

    if (!["winning", "loss"].includes(adjustmentType)) {
      throw new Error('Adjustment type must be "winning" or "loss"');
    }

    const balance = await this.getPlayerChipBalance(
      playerId,
      session.session_id
    );

    // Calculate new balance
    let newBalance;
    if (adjustmentType === "winning") {
      // Player WON at table - add chips to their balance
      newBalance = parseFloat(balance.current_chip_balance) + adjustmentAmount;
    } else {
      // Player LOST at table - deduct chips from their balance
      if (adjustmentAmount > parseFloat(balance.current_chip_balance)) {
        throw new Error(
          `Player cannot lose ₹${adjustmentAmount}. Only has ₹${balance.current_chip_balance}`
        );
      }
      newBalance = parseFloat(balance.current_chip_balance) - adjustmentAmount;
    }

    // Create transaction record
    const result = await db.insert("tbl_transactions", {
      session_id: session.session_id,
      transaction_type: "balance_adjustment",
      player_id: playerId,
      player_name: player.player_name,
      amount: adjustmentAmount,
      chips_amount: adjustmentAmount,
      payment_mode: null,
      wallet_used: null,
      primary_amount: 0,
      secondary_amount: 0,
      notes: `${
        adjustmentType === "winning" ? "Winning" : "Loss"
      }: ₹${adjustmentAmount} (${reason})`,
      created_by: userId,
      created_at: new Date(),
    });

    // Update player chip balance
    if (adjustmentType === "winning") {
      await this.updatePlayerChipBalance(playerId, session.session_id, {
        chips_received: adjustmentAmount,
      });
    } else {
      await this.updatePlayerChipBalance(playerId, session.session_id, {
        chips_returned: adjustmentAmount,
      });
    }

    return {
      transaction_id: result.insert_id,
      adjustment_type: adjustmentType,
      adjustment_amount: adjustmentAmount,
      previous_balance: parseFloat(balance.current_chip_balance),
      new_balance: newBalance,
      message: `Player ${
        adjustmentType === "winning" ? "won" : "lost"
      } ₹${adjustmentAmount}. New balance: ₹${newBalance}`,
    };
  }

  /**
   * ✅ Get adjustment history for player today
   */
  async getPlayerAdjustmentHistory(playerId) {
    const session = await this.validateSession();

    const adjustments = await db.selectAll(
      "tbl_transactions",
      "*",
      "session_id = ? AND player_id = ? AND transaction_type = ?",
      [session.session_id, playerId, "balance_adjustment"],
      "ORDER BY created_at DESC"
    );

    return adjustments || [];
  }

  /**
   * ✅ BUY-IN with CHIP BREAKDOWN
   * Cashier decides which chips to give
   * Money goes to SECONDARY wallet
   */
  async createBuyIn(data, userId) {
    const session = await this.validateSession();
    const playerId = await this.getPlayerId(data);
    const player = await playerService.getPlayer(playerId);

    const validPaymentModes = [
      "cash",
      "online_sbi",
      "online_hdfc",
      "online_icici",
      "online_other",
    ];
    if (!validPaymentModes.includes(data.payment_mode)) {
      throw new Error("Invalid payment mode");
    }

    const amount = parseFloat(data.amount);
    const chips = parseFloat(data.chips_amount || amount);

    // ✅ CHIP BREAKDOWN IS MANDATORY
    if (!data.chip_breakdown) {
      throw new Error(
        "Chip breakdown is required. Please specify which chips are being given to the player."
      );
    }

    // ✅ VALIDATE CHIP BREAKDOWN matches amount
    cashierService.validateChipBreakdown(data.chip_breakdown, chips);

    // ✅ NO INVENTORY CHECK - Cashier manages their own physical chips
    // System only tracks what chips go in/out, doesn't restrict
    // Cashier is responsible for having enough chips physically

    // Create transaction with chip breakdown
    const result = await db.insert("tbl_transactions", {
      session_id: session.session_id,
      transaction_type: "buy_in",
      player_id: playerId,
      player_name: player.player_name,
      amount: amount,
      chips_amount: chips,
      payment_mode: data.payment_mode,
      wallet_used: "secondary",
      primary_amount: 0,
      secondary_amount: amount,

      // ✅ CHIP BREAKDOWN
      chips_100: data.chip_breakdown.chips_100 || 0,
      chips_500: data.chip_breakdown.chips_500 || 0,
      chips_5000: data.chip_breakdown.chips_5000 || 0,
      chips_10000: data.chip_breakdown.chips_10000 || 0,

      notes:
        data.notes ||
        this.generateChipBreakdownNote(data.chip_breakdown, "given"),
      created_by: userId,
      created_at: new Date(),
    });

    // Update player chip balance
    await this.updatePlayerChipBalance(playerId, session.session_id, {
      chips_received: chips,
      bought_in: amount,
    });

    // ✅ CRITICAL FIX: UPDATE CHIP INVENTORY (chips given to player)
    // This now DEDUCTS chips from cashier's current inventory
    // AND increases chips_out (tracking what's with players)
    await cashierService.updateChipInventory(
      session.session_id,
      data.chip_breakdown,
      true // true = giving out chips (reduces current, increases out)
    );

    // Update session - add cash to secondary wallet
    await db.update(
      "tbl_daily_sessions",
      {
        secondary_wallet: parseFloat(session.secondary_wallet || 0) + amount,
        secondary_wallet_deposits:
          parseFloat(session.secondary_wallet_deposits || 0) + amount,
        total_deposits: parseFloat(session.total_deposits || 0) + amount,
        total_cash_deposits:
          data.payment_mode === "cash"
            ? parseFloat(session.total_cash_deposits || 0) + amount
            : parseFloat(session.total_cash_deposits || 0),
        total_online_deposits: data.payment_mode.startsWith("online_")
          ? parseFloat(session.total_online_deposits || 0) + amount
          : parseFloat(session.total_online_deposits || 0),
        total_chips_out: parseFloat(session.total_chips_out || 0) + chips,
      },
      "session_id = ?",
      [session.session_id]
    );

    await playerService.updatePlayerTransactionStats(
      playerId,
      "buy_in",
      amount
    );
    await playerService.recordPlayerVisit(playerId, session.session_id);

    return {
      transaction_id: result.insert_id,
      amount: amount,
      chips_given: chips,
      chip_breakdown: data.chip_breakdown,
      message: `Buy-in successful. Player paid ₹${amount} and received ${chips} chips (${this.formatChipBreakdown(
        data.chip_breakdown
      )}). Chips deducted from cashier inventory.`,
    };
  }

  // ✅ ADD THIS HELPER METHOD to transaction.service.js
  async validateChipInventoryAvailable(sessionId, chipBreakdown) {
    const session = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_id = ?",
      [sessionId]
    );

    const needed = {
      chips_100: chipBreakdown.chips_100 || 0,
      chips_500: chipBreakdown.chips_500 || 0,
      chips_5000: chipBreakdown.chips_5000 || 0,
      chips_10000: chipBreakdown.chips_10000 || 0,
    };

    const available = {
      chips_100: parseInt(session.chips_100_current || 0),
      chips_500: parseInt(session.chips_500_current || 0),
      chips_5000: parseInt(session.chips_5000_current || 0),
      chips_10000: parseInt(session.chips_10000_current || 0),
    };

    const insufficient = [];

    if (needed.chips_100 > available.chips_100) {
      insufficient.push(
        `₹100: need ${needed.chips_100}, have ${available.chips_100}`
      );
    }
    if (needed.chips_500 > available.chips_500) {
      insufficient.push(
        `₹500: need ${needed.chips_500}, have ${available.chips_500}`
      );
    }
    if (needed.chips_5000 > available.chips_5000) {
      insufficient.push(
        `₹5000: need ${needed.chips_5000}, have ${available.chips_5000}`
      );
    }
    if (needed.chips_10000 > available.chips_10000) {
      insufficient.push(
        `₹10000: need ${needed.chips_10000}, have ${available.chips_10000}`
      );
    }

    return {
      available: insufficient.length === 0,
      message:
        insufficient.length > 0
          ? insufficient.join(", ")
          : "All chips available",
    };
  }

  // ✅ ADD THIS HELPER METHOD to transaction.service.js
  async validateChipInventoryAvailable(sessionId, chipBreakdown) {
    const session = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_id = ?",
      [sessionId]
    );

    const needed = {
      chips_100: chipBreakdown.chips_100 || 0,
      chips_500: chipBreakdown.chips_500 || 0,
      chips_5000: chipBreakdown.chips_5000 || 0,
      chips_10000: chipBreakdown.chips_10000 || 0,
    };

    const available = {
      chips_100: parseInt(session.chips_100_current || 0),
      chips_500: parseInt(session.chips_500_current || 0),
      chips_5000: parseInt(session.chips_5000_current || 0),
      chips_10000: parseInt(session.chips_10000_current || 0),
    };

    const insufficient = [];

    if (needed.chips_100 > available.chips_100) {
      insufficient.push(
        `₹100: need ${needed.chips_100}, have ${available.chips_100}`
      );
    }
    if (needed.chips_500 > available.chips_500) {
      insufficient.push(
        `₹500: need ${needed.chips_500}, have ${available.chips_500}`
      );
    }
    if (needed.chips_5000 > available.chips_5000) {
      insufficient.push(
        `₹5000: need ${needed.chips_5000}, have ${available.chips_5000}`
      );
    }
    if (needed.chips_10000 > available.chips_10000) {
      insufficient.push(
        `₹10000: need ${needed.chips_10000}, have ${available.chips_10000}`
      );
    }

    return {
      available: insufficient.length === 0,
      message:
        insufficient.length > 0
          ? insufficient.join(", ")
          : "All chips available",
    };
  }

  // ✅ UPDATED cashierService.updateChipInventory
  // This is the CORRECT implementation that should be in cashier.service.js
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
      // ✅ GIVING CHIPS TO PLAYER (Buy-in, Credit, Redeem)
      // - DECREASE chips_current (cashier has fewer chips)
      // - INCREASE chips_out (more chips with players)
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

      // ✅ CHECK for insufficient chips
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

        throw new Error(
          `Insufficient chips in inventory: ${shortages.join(", ")}. ` +
            `Please add float (mali) with chips first.`
        );
      }
    } else {
      // ✅ RECEIVING CHIPS BACK FROM PLAYER (Cash payout, Deposit, Return)
      // - INCREASE chips_current (cashier has more chips)
      // - DECREASE chips_out (fewer chips with players)
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

      // Note: chips_out can go negative if player returns more than received
      // This indicates house profit from player winnings
    }

    await db.update("tbl_daily_sessions", updates, "session_id = ?", [
      sessionId,
    ]);

    return {
      success: true,
      updates: updates,
    };
  }

  // ✅ ADD THIS HELPER METHOD to transaction.service.js
  async validateChipInventoryAvailable(sessionId, chipBreakdown) {
    const session = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_id = ?",
      [sessionId]
    );

    const needed = {
      chips_100: chipBreakdown.chips_100 || 0,
      chips_500: chipBreakdown.chips_500 || 0,
      chips_5000: chipBreakdown.chips_5000 || 0,
      chips_10000: chipBreakdown.chips_10000 || 0,
    };

    const available = {
      chips_100: parseInt(session.chips_100_current || 0),
      chips_500: parseInt(session.chips_500_current || 0),
      chips_5000: parseInt(session.chips_5000_current || 0),
      chips_10000: parseInt(session.chips_10000_current || 0),
    };

    const insufficient = [];

    if (needed.chips_100 > available.chips_100) {
      insufficient.push(
        `₹100: need ${needed.chips_100}, have ${available.chips_100}`
      );
    }
    if (needed.chips_500 > available.chips_500) {
      insufficient.push(
        `₹500: need ${needed.chips_500}, have ${available.chips_500}`
      );
    }
    if (needed.chips_5000 > available.chips_5000) {
      insufficient.push(
        `₹5000: need ${needed.chips_5000}, have ${available.chips_5000}`
      );
    }
    if (needed.chips_10000 > available.chips_10000) {
      insufficient.push(
        `₹10000: need ${needed.chips_10000}, have ${available.chips_10000}`
      );
    }

    return {
      available: insufficient.length === 0,
      message:
        insufficient.length > 0
          ? insufficient.join(", ")
          : "All chips available",
    };
  }

  /**
   * ✅ GET PLAYER'S STORED CHIPS BALANCE
   * Returns the global stored chips balance from tbl_players
   */
  async getPlayerStoredBalance(playerId) {
    const player = await db.select(
      "tbl_players",
      "player_id, player_name, player_code, stored_chips",
      "player_id = ?",
      [playerId]
    );

    // ✅ Return 0 if player not found instead of throwing error
    if (!player) {
      return {
        player_id: playerId,
        player_name: null,
        player_code: null,
        stored_chips: 0,
      };
    }

    return {
      player_id: player.player_id,
      player_name: player.player_name,
      player_code: player.player_code,
      stored_chips: parseFloat(player.stored_chips || 0),
    };
  }

  /**
   * ✅ REDEEM STORED CHIPS (Use stored balance for buy-in)
   * Player uses their stored chip balance instead of paying cash
   * Chips go OUT from inventory, stored balance decreases
   * Accepts either chip_breakdown OR amount (amount will auto-calculate breakdown)
   */
  async redeemStoredChips(data, userId) {
    const session = await this.validateSession();
    const playerId = await this.getPlayerId(data);
    const player = await playerService.getPlayer(playerId);

    // Get player's stored balance
    const storedBalance = parseFloat(player.stored_chips || 0);

    let redeemAmount = 0;
    let chipBreakdown = data.chip_breakdown;

    // ✅ Accept either chip_breakdown OR amount
    if (data.chip_breakdown) {
      // Calculate redemption amount from chip breakdown
      redeemAmount =
        (parseInt(data.chip_breakdown.chips_100) || 0) * 100 +
        (parseInt(data.chip_breakdown.chips_500) || 0) * 500 +
        (parseInt(data.chip_breakdown.chips_5000) || 0) * 5000 +
        (parseInt(data.chip_breakdown.chips_10000) || 0) * 10000;
    } else if (data.amount) {
      // Auto-calculate optimal chip breakdown from amount
      redeemAmount = parseFloat(data.amount);
      chipBreakdown = this.calculateOptimalChipBreakdown(redeemAmount);
    } else {
      throw new Error("Either chip_breakdown or amount is required.");
    }

    if (redeemAmount <= 0) {
      throw new Error("Please enter a valid amount.");
    }

    // ✅ VALIDATE: Cannot redeem more than stored balance
    if (redeemAmount > storedBalance) {
      throw new Error(
        `Insufficient stored balance. Player has ₹${storedBalance.toLocaleString(
          "en-IN"
        )} stored but trying to redeem ₹${redeemAmount.toLocaleString(
          "en-IN"
        )}.`
      );
    }

    // Create transaction
    const result = await db.insert("tbl_transactions", {
      session_id: session.session_id,
      transaction_type: "redeem_stored",
      player_id: playerId,
      player_name: player.player_name,
      amount: 0, // No cash involved
      chips_amount: redeemAmount,
      payment_mode: "stored_balance",
      wallet_used: null,
      primary_amount: 0,
      secondary_amount: 0,

      // ✅ CHIP BREAKDOWN
      chips_100: chipBreakdown.chips_100 || 0,
      chips_500: chipBreakdown.chips_500 || 0,
      chips_5000: chipBreakdown.chips_5000 || 0,
      chips_10000: chipBreakdown.chips_10000 || 0,

      notes:
        data.notes ||
        `Player redeemed ₹${redeemAmount.toLocaleString(
          "en-IN"
        )} from stored balance (${this.formatChipBreakdown(chipBreakdown)})`,
      created_by: userId,
      created_at: new Date(),
    });

    // ✅ Update player chip balance for this session
    const balance = await this.getPlayerChipBalance(
      playerId,
      session.session_id
    );
    await this.updatePlayerChipBalance(playerId, session.session_id, {
      chips_received: redeemAmount,
    });

    // ✅ UPDATE CHIP INVENTORY - chips go out to player
    await cashierService.updateChipInventory(
      session.session_id,
      chipBreakdown,
      true // giving out chips
    );

    // ✅ Update session chips out
    await db.update(
      "tbl_daily_sessions",
      {
        total_chips_out:
          parseFloat(session.total_chips_out || 0) + redeemAmount,
      },
      "session_id = ?",
      [session.session_id]
    );

    // ✅ Decrease player's global stored chips
    const newStoredBalance = storedBalance - redeemAmount;
    await db.query(
      `UPDATE tbl_players SET stored_chips = ? WHERE player_id = ?`,
      [newStoredBalance, playerId]
    );

    // Also update session-level stored chips tracking
    await this.updatePlayerChipBalance(playerId, session.session_id, {
      stored_chips: Math.max(
        0,
        parseFloat(balance.stored_chips || 0) - redeemAmount
      ),
    });

    await playerService.recordPlayerVisit(playerId, session.session_id);

    return {
      transaction_id: result.insert_id,
      chips_given: redeemAmount,
      chip_breakdown: chipBreakdown,
      previous_stored_balance: storedBalance,
      new_stored_balance: newStoredBalance,
      message: `₹${redeemAmount.toLocaleString(
        "en-IN"
      )} chips given from stored balance. Remaining stored: ₹${newStoredBalance.toLocaleString(
        "en-IN"
      )}`,
    };
  }

 async createCashPayout(data, userId) {
    const session = await this.validateSession();
    const playerId = await this.getPlayerId(data);
    const player = await playerService.getPlayer(playerId);
    const balance = await this.getPlayerChipBalance(
      playerId,
      session.session_id
    );

    const chipsToReturn = parseFloat(data.chips_amount);

    // ✅ GET OUTSTANDING CREDIT FROM tbl_credits
    const outstandingCreditsRecords = await db.selectAll(
      "tbl_credits",
      "*",
      "session_id = ? AND player_id = ? AND is_fully_settled = 0",
      [session.session_id, playerId]
    );

    let outstandingCredit = 0;
    if (outstandingCreditsRecords && outstandingCreditsRecords.length > 0) {
      outstandingCredit = outstandingCreditsRecords.reduce((sum, credit) => {
        return sum + parseFloat(credit.credit_outstanding || 0);
      }, 0);
    }

    // ✅ VALIDATE CHIP BREAKDOWN
    if (!data.chip_breakdown) {
      throw new Error(
        "Chip breakdown is required. Please specify which chips the player is returning."
      );
    }

    await this.validateChipInventoryAvailable(
      session.session_id,
      data.chip_breakdown
    );

    // ✅ AUTO-SETTLE CREDIT FROM CHIPS
    let creditSettledFromChips = 0;
    let chipBreakdownForCredit = {
      chips_100: 0,
      chips_500: 0,
      chips_5000: 0,
      chips_10000: 0,
    };

    if (outstandingCredit > 0) {
      creditSettledFromChips = Math.min(chipsToReturn, outstandingCredit);

      if (creditSettledFromChips > 0) {
        const ratio = creditSettledFromChips / chipsToReturn;
        chipBreakdownForCredit = {
          chips_100: Math.floor((data.chip_breakdown.chips_100 || 0) * ratio),
          chips_500: Math.floor((data.chip_breakdown.chips_500 || 0) * ratio),
          chips_5000: Math.floor((data.chip_breakdown.chips_5000 || 0) * ratio),
          chips_10000: Math.floor(
            (data.chip_breakdown.chips_10000 || 0) * ratio
          ),
        };
      }

      // Record credit settlement transaction
      await db.insert("tbl_transactions", {
        session_id: session.session_id,
        transaction_type: "settle_credit",
        player_id: playerId,
        player_name: player.player_name,
        amount: creditSettledFromChips,
        chips_amount: creditSettledFromChips,
        payment_mode: "chips",
        wallet_used: null,
        primary_amount: 0,
        secondary_amount: 0,
        chips_100: chipBreakdownForCredit.chips_100,
        chips_500: chipBreakdownForCredit.chips_500,
        chips_5000: chipBreakdownForCredit.chips_5000,
        chips_10000: chipBreakdownForCredit.chips_10000,
        notes: `Auto-settled ₹${creditSettledFromChips} credit using winning chips during cash out`,
        created_by: userId,
        created_at: new Date(),
      });

      // Update credit records
      const credits = await db.selectAll(
        "tbl_credits",
        "*",
        "session_id = ? AND player_id = ? AND is_fully_settled = 0",
        [session.session_id, playerId],
        "ORDER BY credit_id ASC"
      );

      let remainingToSettle = creditSettledFromChips;

      if (credits && credits.length > 0) {
        for (const credit of credits) {
          if (remainingToSettle <= 0) break;

          const creditOutstanding = parseFloat(credit.credit_outstanding || 0);
          const settleAmount = Math.min(remainingToSettle, creditOutstanding);

          const newSettled = parseFloat(credit.credit_settled) + settleAmount;
          const newOutstanding = creditOutstanding - settleAmount;
          const isFullySettled = newOutstanding <= 0 ? 1 : 0;

          await db.update(
            "tbl_credits",
            {
              credit_settled: newSettled,
              credit_outstanding: Math.max(0, newOutstanding),
              is_fully_settled: isFullySettled,
              settled_at: isFullySettled ? new Date() : null,
            },
            "credit_id = ?",
            [credit.credit_id]
          );

          remainingToSettle -= settleAmount;
        }
      }

      await this.updatePlayerChipBalance(playerId, session.session_id, {
        credit_settled: creditSettledFromChips,
        credit_change: -creditSettledFromChips,
      });

      // Recalculate outstanding credit
      const remainingCreditsAfterSettlement = await db.selectAll(
        "tbl_credits",
        "*",
        "session_id = ? AND is_fully_settled = 0",
        [session.session_id]
      );
      const newOutstandingCreditTotal = remainingCreditsAfterSettlement.reduce(
        (sum, credit) => sum + parseFloat(credit.credit_outstanding || 0),
        0
      );

      await db.update(
        "tbl_daily_sessions",
        {
          outstanding_credit: newOutstandingCreditTotal,
        },
        "session_id = ?",
        [session.session_id]
      );
    }

    // ✅ CALCULATE NET CASH PAYOUT
    const netCashPayout = chipsToReturn - creditSettledFromChips;

    if (netCashPayout < 0) {
      throw new Error(
        `Cannot cash out. Chips returned (₹${chipsToReturn}) < Outstanding credit (₹${outstandingCredit}). ` +
          `Player must pay ₹${Math.abs(netCashPayout)} before leaving.`
      );
    }

    // ✅ RETURN ALL CHIPS to inventory
    await cashierService.updateChipInventory(
      session.session_id,
      data.chip_breakdown,
      false
    );

    await this.updatePlayerChipBalance(playerId, session.session_id, {
      chips_returned: chipsToReturn,
      cashed_out: netCashPayout,
    });

    // ✅ PAY CASH - FIXED WALLET CALCULATION
    let transactionId = null;
    if (netCashPayout > 0) {
      let secondaryUsed = 0;
      let primaryUsed = 0;

      const secondaryAvailable = parseFloat(session.secondary_wallet || 0);
      const primaryAvailable =
        parseFloat(session.opening_float || 0) -
        parseFloat(session.total_withdrawals || 0) -
        parseFloat(session.total_expenses || 0);

      // Priority: Use secondary wallet FIRST, then primary
      if (netCashPayout <= secondaryAvailable) {
        // Case 1: Secondary has enough
        secondaryUsed = netCashPayout;
        primaryUsed = 0;
      } else {
        // Case 2: Use ALL secondary + rest from primary
        secondaryUsed = secondaryAvailable;
        primaryUsed = netCashPayout - secondaryAvailable;

        // Check if we have enough in primary
        const totalAvailable = secondaryAvailable + primaryAvailable;
        if (netCashPayout > totalAvailable) {
          const shortage = netCashPayout - totalAvailable;
          throw new Error(
            `Insufficient cash for payout. ` +
              `Need: ₹${netCashPayout.toLocaleString("en-IN")}, ` +
              `Available: ₹${totalAvailable.toLocaleString("en-IN")} ` +
              `(Secondary: ₹${secondaryAvailable.toLocaleString(
                "en-IN"
              )}, Primary: ₹${primaryAvailable.toLocaleString("en-IN")}). ` +
              `Please add ₹${shortage.toLocaleString(
                "en-IN"
              )} float to continue.`
          );
        }
      }

      // Record cash payout transaction
      const result = await db.insert("tbl_transactions", {
        session_id: session.session_id,
        transaction_type: "cash_payout",
        player_id: playerId,
        player_name: player.player_name,
        amount: netCashPayout,
        chips_amount: chipsToReturn,
        payment_mode: "cash",
        wallet_used:
          secondaryUsed > 0 && primaryUsed > 0
            ? "both"
            : secondaryUsed > 0
            ? "secondary"
            : "primary",
        primary_amount: primaryUsed,
        secondary_amount: secondaryUsed,
        chips_100: data.chip_breakdown.chips_100 || 0,
        chips_500: data.chip_breakdown.chips_500 || 0,
        chips_5000: data.chip_breakdown.chips_5000 || 0,
        chips_10000: data.chip_breakdown.chips_10000 || 0,
        notes:
          creditSettledFromChips > 0
            ? `CASHOUT: Chips ₹${chipsToReturn} → Credit settled ₹${creditSettledFromChips} → Net cash ₹${netCashPayout} (Secondary: ₹${secondaryUsed}, Primary: ₹${primaryUsed})`
            : `CASHOUT: Chips ₹${chipsToReturn} → Cash paid ₹${netCashPayout} (Secondary: ₹${secondaryUsed}, Primary: ₹${primaryUsed})`,
        created_by: userId,
        created_at: new Date(),
      });

      transactionId = result.insert_id;

      // ✅ UPDATE WALLETS - FIXED: Now includes primary_wallet update
      const updates = {
        total_chips_out:
          parseFloat(session.total_chips_out || 0) - chipsToReturn,
      };

      // Update secondary wallet if used
      if (secondaryUsed > 0) {
        updates.secondary_wallet = Math.max(
          0,
          parseFloat(session.secondary_wallet) - secondaryUsed
        );
        updates.secondary_wallet_withdrawals =
          parseFloat(session.secondary_wallet_withdrawals || 0) + secondaryUsed;
      }

      // ✅ FIX: Update primary wallet if used
      if (primaryUsed > 0) {
        updates.primary_wallet = parseFloat(session.primary_wallet || 0) - primaryUsed;
        updates.total_withdrawals =
          parseFloat(session.total_withdrawals || 0) + primaryUsed;
      }

      await db.update("tbl_daily_sessions", updates, "session_id = ?", [
        session.session_id,
      ]);
    } else {
      // No cash payout, only chip return
      await db.update(
        "tbl_daily_sessions",
        {
          total_chips_out:
            parseFloat(session.total_chips_out || 0) - chipsToReturn,
        },
        "session_id = ?",
        [session.session_id]
      );
    }

    await playerService.updatePlayerTransactionStats(
      playerId,
      "cash_payout",
      netCashPayout
    );

    return {
      transaction_id: transactionId,
      chips_returned: chipsToReturn,
      chip_breakdown: data.chip_breakdown,
      credit_auto_settled: creditSettledFromChips,
      net_cash_payout: netCashPayout,
      remaining_credit: Math.max(0, outstandingCredit - creditSettledFromChips),
      fully_settled: outstandingCredit - creditSettledFromChips <= 0,
      message:
        creditSettledFromChips > 0
          ? `✅ Player returned ₹${chipsToReturn} in chips. ` +
            `₹${creditSettledFromChips} credit auto-settled. ` +
            `Net cash paid: ₹${netCashPayout}`
          : `✅ Cash out completed. ₹${netCashPayout} paid for ${chipsToReturn} chips returned.`,
    };
  }

  async depositChips(data, userId) {
    const session = await this.validateSession();
    const playerId = await this.getPlayerId(data);
    const player = await playerService.getPlayer(playerId);

    const balance = await this.getPlayerChipBalance(
      playerId,
      session.session_id
    );

    // ✅ CHIP BREAKDOWN IS MANDATORY - Cashier counts actual chips
    if (!data.chip_breakdown) {
      throw new Error(
        "Chip breakdown is required. Please count and enter the chips player is depositing."
      );
    }

    // Calculate deposit amount from chip breakdown (actual chips counted)
    const depositAmount =
      (parseInt(data.chip_breakdown.chips_100) || 0) * 100 +
      (parseInt(data.chip_breakdown.chips_500) || 0) * 500 +
      (parseInt(data.chip_breakdown.chips_5000) || 0) * 5000 +
      (parseInt(data.chip_breakdown.chips_10000) || 0) * 10000;

    if (depositAmount <= 0) {
      throw new Error("Please enter at least one chip to deposit.");
    }

    // ✅ NO BALANCE VALIDATION - Player may have won chips at table
    // Cashier is counting actual physical chips, that's the source of truth

    const result = await db.insert("tbl_transactions", {
      session_id: session.session_id,
      transaction_type: "deposit_chips",
      player_id: playerId,
      player_name: player.player_name,
      amount: 0, // No cash involved
      chips_amount: depositAmount,
      payment_mode: null,

      // ✅ CHIP BREAKDOWN
      chips_100: data.chip_breakdown.chips_100 || 0,
      chips_500: data.chip_breakdown.chips_500 || 0,
      chips_5000: data.chip_breakdown.chips_5000 || 0,
      chips_10000: data.chip_breakdown.chips_10000 || 0,

      notes:
        data.notes ||
        `Player depositing ₹${depositAmount} chips for future use (${this.formatChipBreakdown(
          data.chip_breakdown
        )})`,
      created_by: userId,
      created_at: new Date(),
    });

    // ✅ Update stored chips balance
    const newStoredChips =
      parseFloat(balance.stored_chips || 0) + depositAmount;
    await this.updatePlayerChipBalance(playerId, session.session_id, {
      chips_returned: depositAmount,
      stored_chips: newStoredChips,
    });

    // ✅ UPDATE CHIP INVENTORY - chips come back to cashier
    await cashierService.updateChipInventory(
      session.session_id,
      data.chip_breakdown,
      false // receiving chips back
    );

    // ✅ Update session chips out (decrease since chips returned)
    await db.update(
      "tbl_daily_sessions",
      {
        total_chips_out: Math.max(
          0,
          parseFloat(session.total_chips_out || 0) - depositAmount
        ),
      },
      "session_id = ?",
      [session.session_id]
    );

    // ✅ Also update player's global stored chips in tbl_players
    await db.query(
      `UPDATE tbl_players SET stored_chips = COALESCE(stored_chips, 0) + ? WHERE player_id = ?`,
      [depositAmount, playerId]
    );

    return {
      transaction_id: result.insert_id,
      chips_deposited: depositAmount,
      chip_breakdown: data.chip_breakdown,
      total_stored_chips: newStoredChips,
      message: `₹${depositAmount.toLocaleString(
        "en-IN"
      )} chips deposited successfully. Total stored balance: ₹${newStoredChips.toLocaleString(
        "en-IN"
      )}`,
    };
  }

  /**
   * ✅ DEPOSIT CASH - Player deposits cash which goes to secondary wallet
   * Use case: Advance payment, credit settlement prep, or general deposit
   */
  async depositCash(data, userId) {
    const session = await this.validateSession();
    const playerId = await this.getPlayerId(data);
    const player = await playerService.getPlayer(playerId);

    const depositAmount = parseFloat(data.amount);
    if (!depositAmount || depositAmount <= 0) {
      throw new Error("Please enter a valid cash amount to deposit");
    }

    // Create transaction record
    const result = await db.insert("tbl_transactions", {
      session_id: session.session_id,
      transaction_type: "deposit_cash",
      player_id: playerId,
      player_name: player.player_name,
      amount: depositAmount,
      chips_amount: 0,
      payment_mode: "cash",
      wallet_used: "secondary",
      primary_amount: 0,
      secondary_amount: depositAmount,
      notes: data.notes || `Cash deposit by ${player.player_name}`,
      created_by: userId,
      created_at: new Date(),
    });

    // ✅ Add to secondary wallet
    await db.update(
      "tbl_daily_sessions",
      {
        secondary_wallet:
          parseFloat(session.secondary_wallet || 0) + depositAmount,
        secondary_wallet_deposits:
          parseFloat(session.secondary_wallet_deposits || 0) + depositAmount,
        total_deposits: parseFloat(session.total_deposits || 0) + depositAmount,
        total_cash_deposits:
          parseFloat(session.total_cash_deposits || 0) + depositAmount,
      },
      "session_id = ?",
      [session.session_id]
    );

    return {
      transaction_id: result.insert_id,
      amount_deposited: depositAmount,
      message: `₹${depositAmount.toLocaleString(
        "en-IN"
      )} cash deposited successfully. Added to secondary wallet.`,
    };
  }

  /**
   * ✅ RETURN CHIPS with breakdown
   */
  async createReturnChips(data, userId) {
    const session = await this.validateSession();
    const playerId = await this.getPlayerId(data);
    const player = await playerService.getPlayer(playerId);

    const balance = await this.getPlayerChipBalance(
      playerId,
      session.session_id
    );
    const requestedChips = parseFloat(data.chips_amount);

    if (requestedChips > parseFloat(balance.current_chip_balance)) {
      throw new Error(
        `Insufficient chips. Player has ₹${balance.current_chip_balance} in chips.`
      );
    }

    // ✅ CHIP BREAKDOWN IS MANDATORY
    if (!data.chip_breakdown) {
      throw new Error(
        "Chip breakdown is required. Please specify which chips the player is returning."
      );
    }

    // ✅ VALIDATE CHIP BREAKDOWN
    cashierService.validateChipBreakdown(data.chip_breakdown, requestedChips);

    const result = await db.insert("tbl_transactions", {
      session_id: session.session_id,
      transaction_type: "return_chips",
      player_id: playerId,
      player_name: player.player_name,
      amount: 0,
      chips_amount: requestedChips,
      payment_mode: null,

      // ✅ CHIP BREAKDOWN
      chips_100: data.chip_breakdown.chips_100 || 0,
      chips_500: data.chip_breakdown.chips_500 || 0,
      chips_5000: data.chip_breakdown.chips_5000 || 0,
      chips_10000: data.chip_breakdown.chips_10000 || 0,

      notes:
        data.notes ||
        `Player storing ₹${requestedChips} chips for next session (${this.formatChipBreakdown(
          data.chip_breakdown
        )})`,
      created_by: userId,
      created_at: new Date(),
    });

    const newStoredChips =
      parseFloat(balance.stored_chips || 0) + requestedChips;
    await this.updatePlayerChipBalance(playerId, session.session_id, {
      chips_returned: requestedChips,
      stored_chips: newStoredChips,
    });

    // ✅ UPDATE CHIP INVENTORY (chips received back)
    await cashierService.updateChipInventory(
      session.session_id,
      data.chip_breakdown,
      false
    );

    await db.update(
      "tbl_daily_sessions",
      {
        total_chips_out:
          parseFloat(session.total_chips_out || 0) - requestedChips,
      },
      "session_id = ?",
      [session.session_id]
    );

    return {
      transaction_id: result.insert_id,
      chips_stored: requestedChips,
      chip_breakdown: data.chip_breakdown,
      total_stored_chips: newStoredChips,
      message: `₹${requestedChips} chips stored (${this.formatChipBreakdown(
        data.chip_breakdown
      )}). Total stored: ₹${newStoredChips}`,
    };
  }

  /**
   * ✅ ISSUE CREDIT with chip breakdown
   */
  async issueCredit(data, userId) {
    const session = await this.validateSession();
    const creditAmount = parseFloat(
      data.credit_amount || data.requested_amount
    );

    // ✅ IMPORTANT: Credit chips DO NOT deduct from existing inventory
    // Credit is issued on credit - chips are virtual/issued on credit
    // NO inventory validation needed for credit issuance
    // Only buy-ins and cashouts involve physical chip inventory

    // Validate chip breakdown
    if (!data.chip_breakdown) {
      throw new Error("Chip breakdown is required for credit issuance");
    }

    const chipsAmount = parseFloat(data.chips_amount || creditAmount);

    // ✅ NO INVENTORY CHECK for credit - chips are issued on credit, not from inventory
    // Chip inventory is only for buy-ins, cashouts, and deposits

    // Create credit record in database
    const creditResult = await db.insert("tbl_credits", {
      session_id: session.session_id,
      player_id: data.player_id,

      // Store chip breakdown for settlement tracking
      chips_100: data.chip_breakdown.chips_100 || 0,
      chips_500: data.chip_breakdown.chips_500 || 0,
      chips_5000: data.chip_breakdown.chips_5000 || 0,
      chips_10000: data.chip_breakdown.chips_10000 || 0,

      credit_issued: creditAmount,
      credit_settled: 0,
      credit_outstanding: creditAmount,
      is_fully_settled: 0,
      credit_request_id: data.credit_request_id || null,
      issued_at: new Date(),
    });

    // Create transaction record
    await db.insert("tbl_transactions", {
      session_id: session.session_id,
      transaction_type: "credit_issued",
      player_id: data.player_id,
      player_name: data.player_name || "",
      amount: creditAmount,
      chips_amount: chipsAmount,
      payment_mode: "credit",
      wallet_used: null, // ✅ NO wallet used for credit
      primary_amount: 0,
      secondary_amount: 0,

      // Store chip breakdown
      chips_100: data.chip_breakdown.chips_100 || 0,
      chips_500: data.chip_breakdown.chips_500 || 0,
      chips_5000: data.chip_breakdown.chips_5000 || 0,
      chips_10000: data.chip_breakdown.chips_10000 || 0,

      notes: data.notes || `Credit issued: ₹${creditAmount} mixed chips`,
      created_by: userId,
      created_at: new Date(),
    });

    // Update session outstanding credit tracking
    await db.update(
      "tbl_daily_sessions",
      {
        outstanding_credit:
          parseFloat(session.outstanding_credit || 0) + creditAmount,
      },
      "session_id = ?",
      [session.session_id]
    );

    return {
      credit_id: creditResult.insert_id,
      credit_issued: creditAmount,
      chips_given: chipsAmount,
      chip_breakdown: data.chip_breakdown,
      message: `✅ Credit issued: ₹${creditAmount} (${this.formatChipBreakdown(
        data.chip_breakdown
      )}). No wallets affected - chips from inventory.`,
    };
  }

  /**
   * ✅ Helper: Check if chip inventory has enough chips
   */
  async validateChipInventoryAvailable(sessionId, chipBreakdown) {
    const session = await db.select(
      "tbl_daily_sessions",
      "*",
      "session_id = ?",
      [sessionId]
    );

    const needed = {
      chips_100: chipBreakdown.chips_100 || 0,
      chips_500: chipBreakdown.chips_500 || 0,
      chips_5000: chipBreakdown.chips_5000 || 0,
      chips_10000: chipBreakdown.chips_10000 || 0,
    };

    const available = {
      chips_100: parseInt(session.chips_100_current),
      chips_500: parseInt(session.chips_500_current),
      chips_5000: parseInt(session.chips_5000_current),
      chips_10000: parseInt(session.chips_10000_current),
    };

    const insufficient = [];

    if (needed.chips_100 > available.chips_100) {
      insufficient.push(
        `₹100: need ${needed.chips_100}, have ${available.chips_100}`
      );
    }
    if (needed.chips_500 > available.chips_500) {
      insufficient.push(
        `₹500: need ${needed.chips_500}, have ${available.chips_500}`
      );
    }
    if (needed.chips_5000 > available.chips_5000) {
      insufficient.push(
        `₹5000: need ${needed.chips_5000}, have ${available.chips_5000}`
      );
    }
    if (needed.chips_10000 > available.chips_10000) {
      insufficient.push(
        `₹10000: need ${needed.chips_10000}, have ${available.chips_10000}`
      );
    }

    return {
      available: insufficient.length === 0,
      message:
        insufficient.length > 0
          ? insufficient.join(", ")
          : "All chips available",
    };
  }

  /**
   * ✅ Helper: Format chip breakdown for display
   */
  formatChipBreakdown(breakdown) {
    const parts = [];
    if (breakdown.chips_100) parts.push(`${breakdown.chips_100}×₹100`);
    if (breakdown.chips_500) parts.push(`${breakdown.chips_500}×₹500`);
    if (breakdown.chips_5000) parts.push(`${breakdown.chips_5000}×₹5000`);
    if (breakdown.chips_10000) parts.push(`${breakdown.chips_10000}×₹10000`);
    return parts.length > 0 ? parts.join(", ") : "No chips";
  }

  /**
   * Generate readable chip breakdown note
   */
  generateChipBreakdownNote(breakdown, action = "given") {
    if (!breakdown) return null;
    const formatted = this.formatChipBreakdown(breakdown);
    return formatted !== "No chips" ? `Chips ${action}: ${formatted}` : null;
  }

  /**
   * ✅ Helper: Calculate optimal chip breakdown from amount
   * Uses largest denominations first for efficiency
   */
  calculateOptimalChipBreakdown(amount) {
    let remaining = parseInt(amount);
    const breakdown = {
      chips_10000: 0,
      chips_5000: 0,
      chips_500: 0,
      chips_100: 0,
    };

    // Start with largest denomination
    breakdown.chips_10000 = Math.floor(remaining / 10000);
    remaining = remaining % 10000;

    breakdown.chips_5000 = Math.floor(remaining / 5000);
    remaining = remaining % 5000;

    breakdown.chips_500 = Math.floor(remaining / 500);
    remaining = remaining % 500;

    breakdown.chips_100 = Math.floor(remaining / 100);

    return breakdown;
  }

  async getPlayerCurrentStatus(playerId) {
    const session = await this.validateSession();
    const balance = await this.getPlayerChipBalance(
      playerId,
      session.session_id
    );
    const player = await playerService.getPlayer(playerId);

    const currentChipValue = parseFloat(balance.current_chip_balance);
    const outstandingCredit = parseFloat(balance.outstanding_credit);

    return {
      player_id: playerId,
      player_code: player.player_code,
      player_name: player.player_name,
      session_id: session.session_id,

      current_chip_balance: currentChipValue,
      chips_out: parseFloat(
        balance.chips_out || balance.outstanding_credit || 0
      ), // Total chips issued as credit
      stored_chips: parseFloat(balance.stored_chips),
      outstanding_credit: outstandingCredit,
      total_bought_in: parseFloat(balance.total_bought_in),
      total_cashed_out: parseFloat(balance.total_cashed_out),

      can_cash_out: outstandingCredit === 0 && currentChipValue > 0,
      can_deposit: currentChipValue > 0,
      must_settle_credit_first: outstandingCredit > 0,

      note: "All amounts in ₹ VALUE. Player can cash out or deposit any amount up to current_chip_balance.",
    };
  }

  /**
   * Settle credit (unchanged)
   */
  async settleCredit(data, userId) {
    const session = await this.validateSession();
    const playerId = await this.getPlayerId(data);
    const player = await playerService.getPlayer(playerId);

    const balance = await this.getPlayerChipBalance(
      playerId,
      session.session_id
    );
    const settleAmount = parseFloat(data.settle_amount);

    if (parseFloat(balance.outstanding_credit) === 0) {
      throw new Error("No outstanding credit for this player");
    }

    if (settleAmount > parseFloat(balance.outstanding_credit)) {
      throw new Error(
        `Settlement amount exceeds outstanding credit. Outstanding: ₹${balance.outstanding_credit}`
      );
    }

    const validPaymentModes = [
      "cash",
      "online_sbi",
      "online_hdfc",
      "online_icici",
      "online_other",
    ];
    if (!validPaymentModes.includes(data.payment_mode)) {
      throw new Error("Invalid payment mode");
    }

    // ✅ FIX: Create transaction record
    const transResult = await db.insert("tbl_transactions", {
      session_id: session.session_id,
      transaction_type: "settle_credit",
      player_id: playerId,
      player_name: player.player_name,
      amount: settleAmount,
      chips_amount: 0, // No chips involved, just cash payment
      payment_mode: data.payment_mode,
      wallet_used: "secondary",
      primary_amount: 0,
      secondary_amount: settleAmount,
      notes: data.notes || `Credit settlement: ₹${settleAmount}`,
      created_by: userId,
      created_at: new Date(),
    });

    // Update player chip balance
    await this.updatePlayerChipBalance(playerId, session.session_id, {
      credit_settled: settleAmount,
      credit_change: -settleAmount,
    });

    // Get and update credit record
    const credit = await db.select(
      "tbl_credits",
      "*",
      "session_id = ? AND player_id = ? AND is_fully_settled = 0",
      [session.session_id, playerId]
    );

    const newOutstanding = parseFloat(credit.credit_outstanding) - settleAmount;
    const newSettled = parseFloat(credit.credit_settled) + settleAmount;
    const isFullySettled = newOutstanding <= 0 ? 1 : 0;

    await db.update(
      "tbl_credits",
      {
        credit_settled: newSettled,
        credit_outstanding: Math.max(0, newOutstanding),
        is_fully_settled: isFullySettled,
        settled_at: isFullySettled ? new Date() : null,
        updated_at: new Date(),
      },
      "credit_id = ?",
      [credit.credit_id]
    );

    // ✅ FIX: Cash comes IN to secondary wallet (player paying credit)
    await db.update(
      "tbl_daily_sessions",
      {
        outstanding_credit: Math.max(
          0,
          parseFloat(session.outstanding_credit) - settleAmount
        ),
        secondary_wallet:
          parseFloat(session.secondary_wallet || 0) + settleAmount,
        secondary_wallet_deposits:
          parseFloat(session.secondary_wallet_deposits || 0) + settleAmount,
        total_deposits: parseFloat(session.total_deposits || 0) + settleAmount,
        total_cash_deposits:
          data.payment_mode === "cash"
            ? parseFloat(session.total_cash_deposits || 0) + settleAmount
            : parseFloat(session.total_cash_deposits || 0),
        total_online_deposits: data.payment_mode.startsWith("online_")
          ? parseFloat(session.total_online_deposits || 0) + settleAmount
          : parseFloat(session.total_online_deposits || 0),
      },
      "session_id = ?",
      [session.session_id]
    );

    await playerService.updatePlayerTransactionStats(
      playerId,
      "settle_credit",
      settleAmount
    );

    return {
      transaction_id: transResult.insert_id,
      settled_amount: settleAmount,
      remaining_credit: Math.max(0, newOutstanding),
      fully_settled: isFullySettled,
      message: isFullySettled
        ? "✅ Credit fully settled! Cash added to secondary wallet."
        : `Partial settlement recorded. Remaining credit: ₹${Math.max(
            0,
            newOutstanding
          )}`,
    };
  }
  async createExpense(data, userId) {
    const session = await this.validateSession();

    const expenseAmount = parseFloat(data.amount);

    // Calculate available in each wallet
    const secondaryAvailable = parseFloat(session.secondary_wallet || 0);
    const primaryAvailable =
      parseFloat(session.opening_float || 0) +
      parseFloat(session.total_deposits || 0) -
      parseFloat(session.total_withdrawals || 0) -
      parseFloat(session.total_expenses || 0);

    const totalAvailable = secondaryAvailable + primaryAvailable;

    if (expenseAmount > totalAvailable) {
      throw new Error(
        `Insufficient funds for expense. Available: ₹${totalAvailable.toLocaleString(
          "en-IN"
        )}`
      );
    }

    // Calculate split: Secondary first, then Primary
    let fromSecondary = 0;
    let fromPrimary = 0;

    if (secondaryAvailable >= expenseAmount) {
      // Full expense from secondary
      fromSecondary = expenseAmount;
      fromPrimary = 0;
    } else {
      // Partial from secondary, rest from primary
      fromSecondary = secondaryAvailable;
      fromPrimary = expenseAmount - secondaryAvailable;
    }

    // Determine wallet_used label
    let walletUsed = "primary";
    if (fromSecondary > 0 && fromPrimary > 0) {
      walletUsed = "split";
    } else if (fromSecondary > 0) {
      walletUsed = "secondary";
    }

    // Build notes with breakdown
    let expenseNotes = data.notes || data.description || "";
    if (fromSecondary > 0 && fromPrimary > 0) {
      expenseNotes += ` [Split: ₹${fromSecondary.toLocaleString(
        "en-IN"
      )} from Secondary + ₹${fromPrimary.toLocaleString(
        "en-IN"
      )} from Primary]`;
    } else if (fromSecondary > 0) {
      expenseNotes += ` [From Secondary Wallet]`;
    } else {
      expenseNotes += ` [From Primary Wallet]`;
    }

    const result = await db.insert("tbl_transactions", {
      session_id: session.session_id,
      transaction_type: "expense",
      player_id: null,
      player_name: null,
      amount: expenseAmount,
      chips_amount: 0,
      payment_mode: "cash",
      wallet_used: walletUsed,
      primary_amount: fromPrimary,
      secondary_amount: fromSecondary,
      notes: expenseNotes,
      created_by: userId,
      created_at: new Date(),
    });

    // Update session - deduct from appropriate wallets
    const updateData = {};

    if (fromPrimary > 0) {
      updateData.total_expenses =
        parseFloat(session.total_expenses || 0) + fromPrimary;
    }

    if (fromSecondary > 0) {
      updateData.secondary_wallet =
        parseFloat(session.secondary_wallet || 0) - fromSecondary;
      updateData.secondary_wallet_withdrawals =
        parseFloat(session.secondary_wallet_withdrawals || 0) + fromSecondary;
    }

    await db.update("tbl_daily_sessions", updateData, "session_id = ?", [
      session.session_id,
    ]);

    return {
      transaction_id: result.insert_id,
      amount: expenseAmount,
      from_secondary: fromSecondary,
      from_primary: fromPrimary,
      wallet_used: walletUsed,
      message:
        fromSecondary > 0 && fromPrimary > 0
          ? `Expense recorded: ₹${fromSecondary.toLocaleString(
              "en-IN"
            )} from Secondary + ₹${fromPrimary.toLocaleString(
              "en-IN"
            )} from Primary`
          : fromSecondary > 0
          ? `Expense recorded: ₹${fromSecondary.toLocaleString(
              "en-IN"
            )} from Secondary Wallet`
          : `Expense recorded: ₹${fromPrimary.toLocaleString(
              "en-IN"
            )} from Primary Wallet`,
    };
  }

  async getPlayerCurrentStatus(playerId) {
    const session = await this.validateSession();
    const balance = await this.getPlayerChipBalance(
      playerId,
      session.session_id
    );

    // ✅ Calculate chips given out to this player (total amount issued, including credits)
    const totalChipsGiven = parseFloat(balance.total_chips_received || 0);

    // ✅ Calculate chips returned by player
    const totalChipsReturned = parseFloat(balance.total_chips_returned || 0);

    const currentChipValue = parseFloat(balance.current_chip_balance); // ₹ VALUE
    const outstandingCredit = parseFloat(balance.outstanding_credit); // ₹ VALUE

    return {
      player_id: playerId,
      session_id: session.session_id,

      // ✅ CHIP IN/OUT TRACKING (in ₹ value)
      chips_given: totalChipsGiven, // 📤 Total chips given to player (cash buyin + credit)
      chips_returned: totalChipsReturned, // 📥 Total chips returned by player
      chips_out: totalChipsGiven, // Same as chips_given (for legacy compatibility)

      // ✅ ALL VALUES IN RUPEES, NOT CHIP COUNT
      current_chip_balance: currentChipValue, // Total ₹ value of chips player currently has
      stored_chips: parseFloat(balance.stored_chips), // ₹ value of chips stored for next session
      outstanding_credit: outstandingCredit, // ₹ value of outstanding credit
      total_bought_in: parseFloat(balance.total_bought_in), // Total ₹ bought in via cash
      total_credit_taken: parseFloat(balance.total_credit_taken || 0), // Total ₹ credit issued
      total_cashed_out: parseFloat(balance.total_cashed_out), // Total ₹ cashed out

      // Status flags
      can_cash_out: outstandingCredit === 0 && currentChipValue > 0,
      must_settle_credit_first: outstandingCredit > 0,

      // ✅ Meta information for clarity
      note: "All chip amounts are in ₹ VALUE (rupee value), not chip count. chips_given = total chips issued to player (buy-in + credit)",
    };
  }

  async getPlayerTransactionHistory(playerId, sessionId = null) {
    let whereClause = "player_id = ?";
    let params = [playerId];

    if (sessionId) {
      whereClause += " AND session_id = ?";
      params.push(sessionId);
    }

    const transactions = await db.selectAll(
      "tbl_transactions",
      "*",
      whereClause,
      params,
      "ORDER BY created_at DESC"
    );

    return transactions || [];
  }

  async getCurrentSessionTransactions() {
    const session = await cashierService.getTodaySession();

    const transactions = await db.selectAll(
      "tbl_transactions",
      "*",
      "session_id = ?",
      [session.session_id],
      "ORDER BY created_at DESC"
    );

    return transactions || [];
  }

  async getOutstandingCredits() {
    const session = await this.validateSession();

    const credits = await db.selectAll(
      "tbl_credits",
      "*",
      "session_id = ? AND is_fully_settled = 0",
      [session.session_id],
      "ORDER BY credit_id DESC"
    );

    const creditsWithDetails = await Promise.all(
      (credits || []).map(async (credit) => {
        const player = await playerService.getPlayer(credit.player_id);
        return {
          ...credit,
          player_name: player.player_name,
          player_code: player.player_code,
          phone_number: player.phone_number,
          remaining_to_settle: parseFloat(credit.credit_outstanding),
        };
      })
    );

    return creditsWithDetails;
  }

  async getTransactionById(transactionId) {
    const transaction = await db.select(
      "tbl_transactions",
      "*",
      "transaction_id = ?",
      [transactionId]
    );

    if (!transaction) {
      throw new Error("Transaction not found");
    }

    return transaction;
  }

  async getAllTransactions(filters = {}) {
    let whereClause = "1=1";
    let params = [];

    if (filters.session_id) {
      whereClause += " AND session_id = ?";
      params.push(filters.session_id);
    }

    if (filters.player_id) {
      whereClause += " AND player_id = ?";
      params.push(filters.player_id);
    }

    if (filters.transaction_type) {
      whereClause += " AND transaction_type = ?";
      params.push(filters.transaction_type);
    }

    if (filters.payment_mode) {
      whereClause += " AND payment_mode = ?";
      params.push(filters.payment_mode);
    }

    if (filters.date_from) {
      whereClause += " AND DATE(created_at) >= ?";
      params.push(filters.date_from);
    }

    if (filters.date_to) {
      whereClause += " AND DATE(created_at) <= ?";
      params.push(filters.date_to);
    }

    const transactions = await db.selectAll(
      "tbl_transactions",
      "*",
      whereClause,
      params,
      "ORDER BY created_at DESC"
    );

    return transactions || [];
  }
}

module.exports = new TransactionService();
