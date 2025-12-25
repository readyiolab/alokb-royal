// modules/transaction/controllers/transaction.controller.js
// UPDATED VERSION WITH PROPER RESPONSES

const transactionService = require('../services/transaction.service');
const { sendSuccess } = require('../../../utils/response.util');
const { logAudit } = require('../../../utils/logger.util');

class TransactionController {
  /**
   * ✅ CREATE BUY-IN TRANSACTION
   * POST /api/transactions/buy-in
   */
  async createBuyIn(req, res, next) {
    try {
      const result = await transactionService.createBuyIn(
        req.body,
        req.user.user_id
      );

      await logAudit(
        req.user.user_id,
        'CREATE_BUYIN',
        'tbl_transactions',
        result.transaction_id,
        null,
        req.body,
        req.ip
      );

      return sendSuccess(
        res,
        'Buy-in transaction created successfully',
        result,
        201
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ CREATE CASH PAYOUT TRANSACTION
   * POST /api/transactions/cash-payout
   */
  async createCashPayout(req, res, next) {
    try {
      const result = await transactionService.createCashPayout(
        req.body,
        req.user.user_id
      );

      await logAudit(
        req.user.user_id,
        'CREATE_CASH_PAYOUT',
        'tbl_transactions',
        result.transaction_id,
        null,
        req.body,
        req.ip
      );

      return sendSuccess(
        res,
        'Cash payout completed successfully',
        result,
        201
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ DEPOSIT CHIPS (New - replaces return chips)
   * POST /api/transactions/deposit-chips
   */
  async depositChips(req, res, next) {
    try {
      const result = await transactionService.depositChips(
        req.body,
        req.user.user_id
      );

      await logAudit(
        req.user.user_id,
        'DEPOSIT_CHIPS',
        'tbl_transactions',
        result.transaction_id,
        null,
        req.body,
        req.ip
      );

      return sendSuccess(
        res,
        result.message,
        result,
        201
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ DEPOSIT CASH - Player deposits cash to secondary wallet
   * POST /api/transactions/deposit-cash
   */
  async depositCash(req, res, next) {
    try {
      const result = await transactionService.depositCash(
        req.body,
        req.user.user_id
      );

      await logAudit(
        req.user.user_id,
        'DEPOSIT_CASH',
        'tbl_transactions',
        result.transaction_id,
        null,
        req.body,
        req.ip
      );

      return sendSuccess(
        res,
        result.message,
        result,
        201
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ CREATE RETURN CHIPS TRANSACTION (Backward compatibility)
   * POST /api/transactions/return-chips
   */
  async createReturnChips(req, res, next) {
    try {
      const result = await transactionService.depositChips(
        req.body,
        req.user.user_id
      );

      await logAudit(
        req.user.user_id,
        'CREATE_RETURN_CHIPS',
        'tbl_transactions',
        result.transaction_id,
        null,
        req.body,
        req.ip
      );

      return sendSuccess(
        res,
        result.message,
        result,
        201
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ ADJUST PLAYER BALANCE
   * POST /api/transactions/adjust-balance
   */
  async adjustPlayerBalance(req, res, next) {
    try {
      const result = await transactionService.adjustPlayerBalance(
        req.body,
        req.user.user_id
      );

      await logAudit(
        req.user.user_id,
        'ADJUST_PLAYER_BALANCE',
        'tbl_transactions',
        result.transaction_id,
        null,
        req.body,
        req.ip
      );

      return sendSuccess(
        res,
        result.message,
        result,
        201
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ GET PLAYER ADJUSTMENT HISTORY
   * GET /api/transactions/player/:playerId/adjustments
   */
  async getPlayerAdjustments(req, res, next) {
    try {
      const { playerId } = req.params;
      
      const adjustments = await transactionService.getPlayerAdjustmentHistory(playerId);

      return sendSuccess(
        res,
        'Player adjustment history retrieved',
        {
          player_id: parseInt(playerId),
          adjustments
        },
        200
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ ISSUE CREDIT
   * POST /api/transactions/issue-credit
   */
  async issueCredit(req, res, next) {
    try {
      const result = await transactionService.issueCredit(
        req.body,
        req.user.user_id
      );

      await logAudit(
        req.user.user_id,
        'ISSUE_CREDIT',
        'tbl_transactions',
        result.transaction_id,
        null,
        req.body,
        req.ip
      );

      return sendSuccess(
        res,
        result.message,
        result,
        201
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ SETTLE CREDIT
   * POST /api/transactions/settle-credit
   */
  async settleCredit(req, res, next) {
    try {
      const result = await transactionService.settleCredit(
        req.body,
        req.user.user_id
      );

      await logAudit(
        req.user.user_id,
        'SETTLE_CREDIT',
        'tbl_transactions',
        result.transaction_id,
        null,
        req.body,
        req.ip
      );

      return sendSuccess(
        res,
        result.message,
        result,
        200
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ CREATE EXPENSE
   * POST /api/transactions/expense
   */
  async createExpense(req, res, next) {
    try {
      const result = await transactionService.createExpense(
        req.body,
        req.user.user_id
      );

      await logAudit(
        req.user.user_id,
        'CREATE_EXPENSE',
        'tbl_transactions',
        result.transaction_id,
        null,
        { ...req.body, ...result },
        req.ip
      );

      return sendSuccess(
        res,
        result.message || 'Expense recorded successfully',
        result,
        201
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ GET PLAYER CHIP BALANCE
   * GET /api/transactions/player/:playerId/chip-balance
   */
  async getPlayerChipBalance(req, res, next) {
    try {
      const { playerId } = req.params;
      const balance = await transactionService.getPlayerCurrentStatus(playerId);

      return sendSuccess(
        res,
        'Player chip balance retrieved successfully',
        balance,
        200
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ GET OUTSTANDING CREDITS
   * GET /api/transactions/outstanding-credits
   */
  async getOutstandingCredits(req, res, next) {
    try {
      const credits = await transactionService.getOutstandingCredits();

      return sendSuccess(
        res, 
        'Outstanding credits retrieved successfully', 
        {
          count: credits.length,
          credits
        },
        200
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ GET CURRENT SESSION TRANSACTIONS
   * GET /api/transactions
   */
  async getCurrentSessionTransactions(req, res, next) {
    try {
      const transactions = await transactionService.getCurrentSessionTransactions();

      return sendSuccess(
        res,
        'Transactions retrieved successfully',
        {
          count: transactions.length,
          transactions
        },
        200
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ GET TRANSACTION BY ID
   * GET /api/transactions/:transactionId
   */
  async getTransactionById(req, res, next) {
    try {
      const { transactionId } = req.params;
      const transaction = await transactionService.getTransactionById(transactionId);

      return sendSuccess(
        res,
        'Transaction retrieved successfully',
        transaction,
        200
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ GET PLAYER TRANSACTION HISTORY
   * GET /api/transactions/player/:playerId
   */
  async getPlayerTransactionHistory(req, res, next) {
    try {
      const { playerId } = req.params;
      const { session_id } = req.query;

      const transactions = await transactionService.getPlayerTransactionHistory(
        playerId,
        session_id
      );

      return sendSuccess(
        res,
        'Player transaction history retrieved successfully',
        {
          player_id: parseInt(playerId),
          session_id: session_id ? parseInt(session_id) : null,
          count: transactions.length,
          transactions
        },
        200
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ GET ALL TRANSACTIONS WITH FILTERS (Admin only)
   * GET /api/transactions/all
   */
  async getAllTransactions(req, res, next) {
    try {
      const filters = {
        session_id: req.query.session_id,
        player_id: req.query.player_id,
        transaction_type: req.query.transaction_type,
        payment_mode: req.query.payment_mode,
        date_from: req.query.date_from,
        date_to: req.query.date_to
      };

      const transactions = await transactionService.getAllTransactions(filters);

      return sendSuccess(
        res,
        'Transactions retrieved successfully',
        {
          filters,
          count: transactions.length,
          transactions
        },
        200
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ GET PLAYER'S STORED CHIPS BALANCE
   * GET /api/transactions/player/:playerId/stored-balance
   */
  async getPlayerStoredBalance(req, res, next) {
    try {
      const { playerId } = req.params;
      const result = await transactionService.getPlayerStoredBalance(playerId);

      return sendSuccess(
        res,
        'Stored balance retrieved successfully',
        result,
        200
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * ✅ REDEEM STORED CHIPS (Use stored balance for buy-in)
   * POST /api/transactions/redeem-stored
   */
  async redeemStoredChips(req, res, next) {
    try {
      const result = await transactionService.redeemStoredChips(
        req.body,
        req.user.user_id
      );

      await logAudit(
        req.user.user_id,
        'REDEEM_STORED_CHIPS',
        'tbl_transactions',
        result.transaction_id,
        null,
        req.body,
        req.ip
      );

      return sendSuccess(
        res,
        result.message,
        result,
        201
      );
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new TransactionController();