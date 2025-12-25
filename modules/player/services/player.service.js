const db = require('../../../config/database');
const kycService = require('../../kyc/services/kyc.service');
class PlayerService {
  // Generate unique player code (PC00001, PC00002, etc.)
  async generatePlayerCode() {
    const lastPlayer = await db.query(
      'SELECT player_code FROM tbl_players ORDER BY player_id DESC LIMIT 1'
    );

    if (!lastPlayer || !lastPlayer.player_code) {
      return 'PC00001';
    }

    const lastNumber = parseInt(lastPlayer.player_code.replace('PC', ''));
    const newNumber = lastNumber + 1;
    const paddedNumber = String(newNumber).padStart(5, '0');
    
    return `PC${paddedNumber}`;
  }

  // ============================================
  // Create new player
  // ============================================
  async createPlayer(data, userId) {
    // Validate required - only player_name is required
    if (!data.player_name) {
      throw new Error('Player name is required');
    }

    // Generate unique player code
    const playerCode = await this.generatePlayerCode();

    // Check if phone already exists (if provided)
    if (data.phone_number) {
      const existingPhone = await db.select(
        'tbl_players',
        'player_id',
        'phone_number = ?',
        [data.phone_number]
      );
      if (existingPhone) {
        throw new Error('Phone number already registered');
      }
    }

    // Check if email already exists (if provided)
    if (data.email) {
      const existingEmail = await db.select(
        'tbl_players',
        'player_id',
        'email = ?',
        [data.email]
      );
      if (existingEmail) {
        throw new Error('Email already registered');
      }
    }

    // Insert player
    const result = await db.insert('tbl_players', {
      player_code: playerCode,
      player_name: data.player_name,
      phone_number: data.phone_number || null,
      email: data.email || null,
      address: data.address || null,
      player_type: data.player_type || 'occasional',
      kyc_status: 'not_started',
      credit_limit: data.credit_limit || 0,
      notes: data.notes || null,
      created_by: userId
    });

    const playerId = result.insert_id;

    // Try to create KYC reminder (don't fail if KYC service unavailable)
    try {
      await kycService.createReminderSchedule(playerId);
    } catch (err) {
      console.log('KYC reminder schedule not created:', err.message);
    }

    // ✅ Return full player data for frontend use
    return {
      player_id: playerId,
      player_code: playerCode,
      player_name: data.player_name,
      phone_number: data.phone_number || null,
      email: data.email || null,
      player_type: data.player_type || 'occasional',
      kyc_status: 'not_started'
    };
  }

  // Get player by ID or player_code
  async getPlayer(identifier) {
    let player;
    
    // Check if identifier is player_code (starts with PC) or player_id
    if (typeof identifier === 'string' && identifier.startsWith('PC')) {
      player = await db.select(
        'tbl_players',
        '*',
        'player_code = ?',
        [identifier]
      );
    } else {
      player = await db.select(
        'tbl_players',
        '*',
        'player_id = ?',
        [identifier]
      );
    }

    if (!player) {
      throw new Error('Player not found');
    }

    return player;
  }

  // Get player by phone number
  async getPlayerByPhone(phoneNumber) {
    const player = await db.select(
      'tbl_players',
      '*',
      'phone_number = ?',
      [phoneNumber]
    );

    if (!player) {
      throw new Error('Player not found');
    }

    return player;
  }

  // Search players (by name, code, or phone)
  async searchPlayers(searchTerm, filters = {}) {
    let whereClause = '(player_name LIKE ? OR player_code LIKE ? OR phone_number LIKE ?)';
    let params = [`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`];

    // Add filters
    if (filters.player_type) {
      whereClause += ' AND player_type = ?';
      params.push(filters.player_type);
    }

    if (filters.is_active !== undefined) {
      whereClause += ' AND is_active = ?';
      params.push(filters.is_active);
    }

    if (filters.is_blacklisted !== undefined) {
      whereClause += ' AND is_blacklisted = ?';
      params.push(filters.is_blacklisted);
    }

    const players = await db.selectAll(
      'tbl_players',
      '*',
      whereClause,
      params,
      'ORDER BY player_name ASC'
    );

    return players;
  }

  // Get all players with pagination and CRM stats
  async getAllPlayers(page = 1, limit = 50, filters = {}) {
    const offset = (page - 1) * limit;
    
    let whereClause = '1=1';
    let params = [];

    if (filters.player_type) {
      whereClause += ' AND player_type = ?';
      params.push(filters.player_type);
    }

    if (filters.is_active !== undefined) {
      whereClause += ' AND is_active = ?';
      params.push(filters.is_active);
    }

    if (filters.is_blacklisted !== undefined) {
      whereClause += ' AND is_blacklisted = ?';
      params.push(filters.is_blacklisted);
    }

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM tbl_players WHERE ${whereClause}`,
      params
    );
    const total = countResult?.total || 0;

    // Get players with calculated CRM stats
    const players = await db.queryAll(
      `SELECT 
        p.*,
        -- Calculate total sessions from table_players
        (SELECT COUNT(DISTINCT tp.table_player_id) 
         FROM tbl_table_players tp 
         WHERE tp.player_id = p.player_id AND tp.is_removed = 1) as total_sessions_played,
        -- Calculate total time played (from removed sessions)
        (SELECT COALESCE(SUM(
          TIMESTAMPDIFF(MINUTE, tp.seated_at, COALESCE(tp.removed_at, NOW()))
        ), 0) 
         FROM tbl_table_players tp 
         WHERE tp.player_id = p.player_id AND tp.is_removed = 1) as total_minutes_played,
        -- Get lifetime net (buy-ins - cash-outs)
        (p.total_buy_ins - p.total_cash_outs) as lifetime_net_value
      FROM tbl_players p
      WHERE ${whereClause} 
      ORDER BY p.created_at DESC 
      LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Calculate additional stats for each player
    const playersWithStats = players.map(player => {
      const totalSessions = player.total_sessions_played || player.visit_count || 0;
      const totalMinutes = player.total_minutes_played || 0;
      const totalHours = parseFloat((totalMinutes / 60).toFixed(2));
      const avgSessionMinutes = totalSessions > 0 ? Math.round(totalMinutes / totalSessions) : 0;
      const avgSessionHours = parseFloat((avgSessionMinutes / 60).toFixed(2));
      
      // Calculate days away
      let daysAway = null;
      if (player.last_visit_date) {
        const lastVisit = new Date(player.last_visit_date);
        const now = new Date();
        daysAway = Math.floor((now - lastVisit) / (1000 * 60 * 60 * 24));
      }

      return {
        ...player,
        // CRM Stats
        total_sessions: totalSessions,
        total_hours_played: totalHours,
        total_minutes_played: totalMinutes,
        avg_session_minutes: avgSessionMinutes,
        avg_session_hours: avgSessionHours,
        lifetime_net: parseFloat(player.lifetime_net_value || 0),
        last_visit: player.last_visit_date,
        days_away: daysAway,
        // For compatibility with frontend
        total_play_time_seconds: totalMinutes * 60,
        avg_session_seconds: avgSessionMinutes * 60,
        last_session_at: player.last_visit_date,
      };
    });

    return {
      players: playersWithStats,
      pagination: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit)
      }
    };
  }

  // Get all players WITH KYC documents (LEFT JOIN)
  async getAllPlayersWithKYC(page = 1, limit = 50, filters = {}) {
    const offset = (page - 1) * limit;
    
    let whereClause = '1=1';
    let params = [];

    if (filters.player_type) {
      whereClause += ' AND p.player_type = ?';
      params.push(filters.player_type);
    }

    if (filters.is_active !== undefined) {
      whereClause += ' AND p.is_active = ?';
      params.push(filters.is_active);
    }

    if (filters.is_blacklisted !== undefined) {
      whereClause += ' AND p.is_blacklisted = ?';
      params.push(filters.is_blacklisted);
    }

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(DISTINCT p.player_id) as total 
       FROM tbl_players p 
       LEFT JOIN tbl_player_kyc k ON p.player_id = k.player_id 
       WHERE ${whereClause}`,
      params
    );
    const total = countResult?.total || 0;

    // Get players with KYC documents - SQL LEFT JOIN
    const players = await db.queryAll(
      `SELECT 
        p.player_id,
        p.player_code,
        p.player_name,
        p.phone_number,
        p.email,
        p.address,
        p.player_type,
        p.kyc_status,
        p.kyc_completed_at,
        p.credit_limit,
        p.credit_limit_personal,
        p.total_buy_ins,
        p.total_cash_outs,
        p.total_credits_issued,
        p.total_credits_settled,
        p.outstanding_credit,
        p.last_visit_date,
        p.visit_count,
        p.notes,
        p.is_active,
        p.is_blacklisted,
        p.blacklist_reason,
        p.created_by,
        p.created_at,
        p.updated_at,
        k.id_document_front,
        k.id_document_back,
        k.address_proof_document,
        k.photo,
        k.kyc_status as document_kyc_status
       FROM tbl_players p 
       LEFT JOIN tbl_player_kyc k ON p.player_id = k.player_id 
       WHERE ${whereClause}
       ORDER BY p.created_at DESC 
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      players,
      pagination: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit)
      }
    };
  }

  // Update player
  async updatePlayer(playerId, data, userId) {
    const player = await this.getPlayer(playerId);

    // Check if phone already exists (for other players)
    if (data.phone_number && data.phone_number !== player.phone_number) {
      const existingPhone = await db.select(
        'tbl_players',
        'player_id',
        'phone_number = ? AND player_id != ?',
        [data.phone_number, playerId]
      );
      if (existingPhone) {
        throw new Error('Phone number already registered to another player');
      }
    }

    const updateData = {};
    if (data.player_name) updateData.player_name = data.player_name;
    if (data.phone_number !== undefined) updateData.phone_number = data.phone_number;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.address !== undefined) updateData.address = data.address;
    if (data.player_type) updateData.player_type = data.player_type;
    if (data.notes !== undefined) updateData.notes = data.notes;
    // Note: credit_limit is set via separate endpoint for audit trail

    await db.update('tbl_players', updateData, 'player_id = ?', [playerId]);

    return await this.getPlayer(playerId);
  }

  // Get players with incomplete KYC
  async getPlayersWithIncompleteKYC() {
    const players = await db.selectAll(
      'tbl_players',
      '*',
      "kyc_status IN ('not_started', 'pending', 'rejected')",
      [],
      'ORDER BY created_at DESC'
    );

    return players;
  }

  // Remaining methods stay the same...
  async deactivatePlayer(playerId, userId) {
    await db.update(
      'tbl_players',
      { is_active: 0 },
      'player_id = ?',
      [playerId]
    );
  }

  async activatePlayer(playerId, userId) {
    await db.update(
      'tbl_players',
      { is_active: 1 },
      'player_id = ?',
      [playerId]
    );
  }

  // Deactivate player
  async deactivatePlayer(playerId, userId) {
    await db.update(
      'tbl_players',
      { is_active: 0 },
      'player_id = ?',
      [playerId]
    );
  }

  // Activate player
  async activatePlayer(playerId, userId) {
    await db.update(
      'tbl_players',
      { is_active: 1 },
      'player_id = ?',
      [playerId]
    );
  }

  // Blacklist player
  async blacklistPlayer(playerId, reason, userId) {
    await db.update(
      'tbl_players',
      { 
        is_blacklisted: 1,
        blacklist_reason: reason,
        is_active: 0
      },
      'player_id = ?',
      [playerId]
    );
  }

  // Remove from blacklist
  async unblacklistPlayer(playerId, userId) {
    await db.update(
      'tbl_players',
      { 
        is_blacklisted: 0,
        blacklist_reason: null,
        is_active: 1
      },
      'player_id = ?',
      [playerId]
    );
  }

  // Get player statistics (enhanced with CRM data)
  async getPlayerStats(playerId) {
    const player = await this.getPlayer(playerId);

    // Get session data from table_players
    const sessionData = await db.query(
      `SELECT 
        COUNT(DISTINCT table_player_id) as total_sessions,
        COALESCE(SUM(TIMESTAMPDIFF(MINUTE, seated_at, COALESCE(removed_at, NOW()))), 0) as total_minutes
       FROM tbl_table_players 
       WHERE player_id = ? AND is_removed = 1`,
      [playerId]
    );

    const totalSessions = sessionData?.total_sessions || player.visit_count || 0;
    const totalMinutes = sessionData?.total_minutes || 0;
    const totalHours = parseFloat((totalMinutes / 60).toFixed(2));
    const avgSessionMinutes = totalSessions > 0 ? Math.round(totalMinutes / totalSessions) : 0;

    // Calculate days away
    let daysAway = null;
    if (player.last_visit_date) {
      const lastVisit = new Date(player.last_visit_date);
      const now = new Date();
      daysAway = Math.floor((now - lastVisit) / (1000 * 60 * 60 * 24));
    }

    const stats = {
      player_id: playerId,
      player_name: player.player_name,
      player_code: player.player_code,
      
      // Session stats
      total_sessions: totalSessions,
      total_visits: player.visit_count,
      total_hours_played: totalHours,
      total_minutes_played: totalMinutes,
      avg_session_minutes: avgSessionMinutes,
      avg_session_hours: parseFloat((avgSessionMinutes / 60).toFixed(2)),
      
      // Financial stats
      total_buy_ins: parseFloat(player.total_buy_ins || 0),
      total_cash_outs: parseFloat(player.total_cash_outs || 0),
      lifetime_net: parseFloat(player.total_buy_ins || 0) - parseFloat(player.total_cash_outs || 0),
      outstanding_credit: parseFloat(player.outstanding_credit || 0),
      
      // Status
      kyc_status: player.kyc_status,
      player_type: player.player_type,
      is_active: player.is_active,
      
      // Visit info
      last_visit: player.last_visit_date,
      days_away: daysAway,
      
      // For frontend compatibility
      total_play_time_seconds: totalMinutes * 60,
      avg_session_seconds: avgSessionMinutes * 60,
      last_session_at: player.last_visit_date,
    };

    return stats;
  }

  // Add note to player
  async addPlayerNote(playerId, noteData, userId) {
    const result = await db.insert('tbl_player_notes', {
      player_id: playerId,
      note: noteData.note,
      note_type: noteData.note_type || 'general',
      created_by: userId
    });

    return result.insert_id;
  }

  // Get player notes
  async getPlayerNotes(playerId) {
    const notes = await db.queryAll(
      `SELECT pn.*, u.username, u.full_name 
       FROM tbl_player_notes pn
       LEFT JOIN tbl_users u ON pn.created_by = u.user_id
       WHERE pn.player_id = ?
       ORDER BY pn.created_at DESC`,
      [playerId]
    );

    return notes;
  }

  // Update player transaction stats (called after each transaction)
  async updatePlayerTransactionStats(playerId, transactionType, amount) {
    const player = await this.getPlayer(playerId);

    const updates = {};
    
    switch (transactionType) {
      case 'buy_in':
        updates.total_buy_ins = parseFloat(player.total_buy_ins) + parseFloat(amount);
        updates.last_visit_date = new Date().toISOString().split('T')[0];
        break;
      
      case 'cash_payout':
        updates.total_cash_outs = parseFloat(player.total_cash_outs) + parseFloat(amount);
        break;
      
      case 'issue_credit':
        updates.total_credits_issued = parseFloat(player.total_credits_issued) + parseFloat(amount);
        updates.outstanding_credit = parseFloat(player.outstanding_credit) + parseFloat(amount);
        break;
      
      case 'settle_credit':
        updates.total_credits_settled = parseFloat(player.total_credits_settled) + parseFloat(amount);
        updates.outstanding_credit = parseFloat(player.outstanding_credit) - parseFloat(amount);
        break;
    }

    if (Object.keys(updates).length > 0) {
      await db.update('tbl_players', updates, 'player_id = ?', [playerId]);
    }
  }

  // Record player visit
  async recordPlayerVisit(playerId, sessionId) {
    const today = new Date().toISOString().split('T')[0];
    
    // Check if visit already recorded for today
    const existingVisit = await db.select(
      'tbl_player_visits',
      'visit_id',
      'player_id = ? AND session_id = ?',
      [playerId, sessionId]
    );

    if (!existingVisit) {
      await db.insert('tbl_player_visits', {
        player_id: playerId,
        session_id: sessionId,
        visit_date: today
      });

      // Increment visit count
      await db.query(
        'UPDATE tbl_players SET visit_count = visit_count + 1, last_visit_date = ? WHERE player_id = ?',
        [today, playerId]
      );
    }
  }

  // Get players with outstanding credit
  async getPlayersWithOutstandingCredit() {
    const players = await db.selectAll(
      'tbl_players',
      '*',
      'outstanding_credit > 0',
      [],
      'ORDER BY outstanding_credit DESC'
    );

    return players;
  }

  // Get top players (by total buy-ins)
  async getTopPlayers(limit = 10) {
    const players = await db.queryAll(
      'SELECT * FROM tbl_players WHERE is_active = 1 ORDER BY total_buy_ins DESC LIMIT ?',
      [limit]
    );

    return players;
  }
}

module.exports = new PlayerService();