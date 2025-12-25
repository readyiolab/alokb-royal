// modules/expense/services/expense.service.js
// Expense Service - Club Expenses & Player Expenses

const db = require('../../../config/database');
const cashierService = require('../../cashier/services/cashier.service');
const staffService = require('../../staff/services/staff.service');

class ExpenseService {
  // ==========================================
  // PLAYER EXPENSES (Chips returned to cashier)
  // ==========================================

  /**
   * Record Player Expense
   * When player returns chips for food, drinks, tips, etc.
   * Chips are returned to cashier inventory
   */
  async recordPlayerExpense(data, userId) {
  // =========================
  // Validate active session
  // =========================
  const session = await cashierService.getTodaySession();
  if (!session) {
    throw new Error('No active session found');
  }

  // =========================
  // Validate chip breakdown
  // =========================
  const chipBreakdown = data.chip_breakdown || {};
  if (
    !chipBreakdown.chips_100 &&
    !chipBreakdown.chips_500 &&
    !chipBreakdown.chips_5000 &&
    !chipBreakdown.chips_10000
  ) {
    throw new Error('Chip breakdown is required');
  }

  // =========================
  // Calculate chip value
  // =========================
  const chips100 = chipBreakdown.chips_100 || 0;
  const chips500 = chipBreakdown.chips_500 || 0;
  const chips5000 = chipBreakdown.chips_5000 || 0;
  const chips10000 = chipBreakdown.chips_10000 || 0;

  const totalValue =
    chips100 * 100 +
    chips500 * 500 +
    chips5000 * 5000 +
    chips10000 * 10000;

  // Validate amount if sent
  if (
    data.chip_amount &&
    Math.abs(parseFloat(data.chip_amount) - totalValue) > 0.01
  ) {
    throw new Error(
      `Chip breakdown value (₹${totalValue}) does not match declared amount (₹${data.chip_amount})`
    );
  }

  // =========================
  // Update chip inventory (chips IN)
  // =========================
  await cashierService.updateChipInventory(
    session.session_id,
    chipBreakdown,
    false // receiving chips
  );

  // =========================
  // CASH PAYMENT (Secondary → Primary)
  // =========================
  const secondaryAvailable = parseFloat(session.secondary_wallet) || 0;
  const primaryAvailable = parseFloat(session.primary_wallet) || 0;

  if (secondaryAvailable + primaryAvailable < totalValue) {
    throw new Error(
      `Insufficient cash. Required ₹${totalValue}, Available ₹${secondaryAvailable + primaryAvailable}`
    );
  }

  let fromSecondary = 0;
  let fromPrimary = 0;

  if (secondaryAvailable >= totalValue) {
    fromSecondary = totalValue;
  } else {
    fromSecondary = secondaryAvailable;
    fromPrimary = totalValue - secondaryAvailable;
  }

  let paidFromWallet = 'secondary';
  if (fromSecondary === 0) {
    paidFromWallet = 'primary';
  } else if (fromPrimary > 0) {
    paidFromWallet = 'split';
  }

  // =========================
  // Create player expense record
  // =========================
  const result = await db.insert('tbl_player_expenses', {
  session_id: session.session_id,
  player_id: data.player_id || null,
  player_name: data.player_name || null,

  chip_amount: totalValue,
  cash_paid_to_vendor: totalValue,   // ✅ IMPORTANT

  chips_100: chips100,
  chips_500: chips500,
  chips_5000: chips5000,
  chips_10000: chips10000,

  expense_category: data.expense_category || 'food',
  paid_from_wallet: paidFromWallet,

  notes:
    paidFromWallet === 'split'
      ? `${data.notes || ''} [Paid ₹${fromSecondary} secondary + ₹${fromPrimary} primary]`.trim()
      : data.notes || null,

  created_by: userId                // ✅ MUST NOT BE NULL
});


  // =========================
  // Update session wallets & totals
  // =========================
  await db.update(
    'tbl_daily_sessions',
    {
      secondary_wallet: secondaryAvailable - fromSecondary,
      primary_wallet: primaryAvailable - fromPrimary,
      total_player_expenses_received:
        (parseFloat(session.total_player_expenses_received) || 0) + totalValue,
      total_expenses:
        (parseFloat(session.total_expenses) || 0) + totalValue
    },
    'session_id = ?',
    [session.session_id]
  );

  // =========================
  // Log chip movement
  // =========================
  await this.logChipMovement(session.session_id, {
    movement_type: 'player_expense',
    direction: 'in',
    player_id: data.player_id || null,
    chip_breakdown: chipBreakdown,
    total_value: totalValue,
    notes: `Player expense (${data.expense_category || 'misc'})`,
    created_by: userId
  });

  // =========================
  // Response
  // =========================
  return {
    expense_id: result.insert_id,
    chip_amount: totalValue,
    chip_breakdown: chipBreakdown,
    paid_from_wallet: paidFromWallet,
    message: `Player expense recorded: ₹${totalValue} (chips returned, cash paid)`
  };
}

  /**
   * Get player expenses for session
   */
  async getPlayerExpensesForSession(sessionId) {
    const expenses = await db.selectAll(
      'tbl_player_expenses',
      '*',
      'session_id = ?',
      [sessionId],
      'ORDER BY created_at DESC'
    );

    return expenses || [];
  }

  // ==========================================
  // CLUB EXPENSES (Operational expenses)
  // ==========================================

  /**
   * Record Club Expense
   * Food delivery, salary advance, utilities, etc.
   * Paid from secondary wallet first, then primary if needed
   */
  async recordClubExpense(data, userId) {
    // Validate session
    const session = await cashierService.getTodaySession();
    if (!session) {
      throw new Error('No active session found');
    }

    const amount = parseFloat(data.amount);
    if (!amount || amount <= 0) {
      throw new Error('Invalid expense amount');
    }

    // Calculate available funds
    const secondaryAvailable = parseFloat(session.secondary_wallet) || 0;
    const primaryAvailable = parseFloat(session.primary_wallet) || 0;
    const totalAvailable = secondaryAvailable + primaryAvailable;

    // Check if total funds are sufficient
    if (amount > totalAvailable) {
      throw new Error(`Insufficient funds. Available: ₹${totalAvailable.toFixed(2)} (Secondary: ₹${secondaryAvailable.toFixed(2)}, Primary: ₹${primaryAvailable.toFixed(2)})`);
    }

    // Determine how to split the payment (secondary first, then primary)
    let fromSecondary = 0;
    let fromPrimary = 0;

    if (amount <= secondaryAvailable) {
      // All from secondary
      fromSecondary = amount;
    } else {
      // Take all from secondary, rest from primary
      fromSecondary = secondaryAvailable;
      fromPrimary = amount - secondaryAvailable;
    }

    // Handle salary advance - link to staff
    let staffId = null;
    if (data.expense_category === 'salary_advance' && data.staff_id) {
      staffId = data.staff_id;
      // Create salary advance record
      await staffService.giveSalaryAdvance(
        staffId,
        { advance_amount: amount, notes: data.notes },
        session.session_id,
        userId
      );
    }

    // Determine wallet used for record
    let paidFromWallet = 'secondary';
    if (fromSecondary === 0) {
      paidFromWallet = 'primary';
    } else if (fromPrimary > 0) {
      paidFromWallet = 'split';
    }

    // Create expense record
    const result = await db.insert('tbl_club_expenses', {
      session_id: session.session_id,
      expense_category: data.expense_category,
      expense_category_label: data.expense_category_label || this.getCategoryLabel(data.expense_category),
      amount: amount,
      paid_from_wallet: paidFromWallet,
      staff_id: staffId,
      notes: fromPrimary > 0 && fromSecondary > 0 
        ? `${data.notes || ''} [Split: ₹${fromSecondary} secondary + ₹${fromPrimary} primary]`.trim()
        : (data.notes || null),
      vendor_name: data.vendor_name || null,
      bill_number: data.bill_number || null,
      created_by: userId

    });

    // Deduct from wallets
    await db.update('tbl_daily_sessions', {
      secondary_wallet: secondaryAvailable - fromSecondary,
      primary_wallet: primaryAvailable - fromPrimary,
      total_club_expenses: (parseFloat(session.total_club_expenses) || 0) + amount,
      total_expenses: (parseFloat(session.total_expenses) || 0) + amount
    }, 'session_id = ?', [session.session_id]);

    // Update salary advance tracking if applicable
    if (data.expense_category === 'salary_advance') {
      await db.update('tbl_daily_sessions', {
        total_salary_advances: (parseFloat(session.total_salary_advances) || 0) + amount
      }, 'session_id = ?', [session.session_id]);
    }

    return {
      expense_id: result.insert_id,
      expense_category: data.expense_category,
      amount: amount,
      paid_from: paidFromWallet,
      message: `Recorded club expense of ₹${amount} (${this.getCategoryLabel(data.expense_category)})`
    };
  }

  getCategoryLabel(category) {
    const labels = {
      food_delivery: 'Food Delivery',
      salary_advance: 'Salary Advance',
      utilities: 'Utilities',
      supplies: 'Supplies',
      maintenance: 'Maintenance',
      miscellaneous: 'Miscellaneous'
    };
    return labels[category] || category;
  }

  /**
   * Get club expenses for session
   */
  async getClubExpensesForSession(sessionId) {
    const expenses = await db.queryAll(`
      SELECT e.*, s.staff_name, s.staff_code
      FROM tbl_club_expenses e
      LEFT JOIN tbl_staff s ON e.staff_id = s.staff_id
      WHERE e.session_id = ?
      ORDER BY e.created_at DESC
    `, [sessionId]);

    return expenses || [];
  }

  /**
   * Get expense summary for session
   */
  async getExpenseSummary(sessionId) {
    const playerExpenses = await this.getPlayerExpensesForSession(sessionId);
    const clubExpenses = await this.getClubExpensesForSession(sessionId);

    let totalPlayerExpenses = 0;
    let totalClubExpenses = 0;

    playerExpenses.forEach(e => {
      totalPlayerExpenses += parseFloat(e.chip_amount);
    });

    clubExpenses.forEach(e => {
      totalClubExpenses += parseFloat(e.amount);
    });

    // Group club expenses by category
    const byCategory = {};
    clubExpenses.forEach(e => {
      if (!byCategory[e.expense_category]) {
        byCategory[e.expense_category] = 0;
      }
      byCategory[e.expense_category] += parseFloat(e.amount);
    });

    return {
      player_expenses: {
        total: totalPlayerExpenses,
        count: playerExpenses.length,
        items: playerExpenses
      },
      club_expenses: {
        total: totalClubExpenses,
        count: clubExpenses.length,
        by_category: byCategory,
        items: clubExpenses
      },
      grand_total: totalPlayerExpenses + totalClubExpenses
    };
  }

  // Log chip movement
  async logChipMovement(sessionId, data) {
    const chipBreakdown = data.chip_breakdown || {};
    const totalChips = 
      (chipBreakdown.chips_100 || 0) +
      (chipBreakdown.chips_500 || 0) +
      (chipBreakdown.chips_5000 || 0) +
      (chipBreakdown.chips_10000 || 0);

    await db.insert('tbl_chip_movement_log', {
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
      created_by: data.created_by
    });
  }
}

module.exports = new ExpenseService();
