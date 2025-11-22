/**
 * Live Session Database Helper
 * Handles all database operations for live video broadcasting
 */

const { pool } = require('./database');

const liveSessionDb = {
  /**
   * Create a new live session
   */
  async createSession(userId, title, emergency = false, targetDevices = []) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Create session
      const sessionResult = await client.query(
        `INSERT INTO live_sessions (user_id, title, emergency, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING *`,
        [userId, title, emergency]
      );

      const session = sessionResult.rows[0];

      // If specific displays targeted, record them
      if (targetDevices.length > 0) {
        for (const displayId of targetDevices) {
          await client.query(
            `INSERT INTO live_session_targets (session_id, display_id)
             VALUES ($1, $2)`,
            [session.id, displayId]
          );
        }
      }

      // Log event
      await client.query(
        `INSERT INTO live_session_events (session_id, event_type, event_data)
         VALUES ($1, 'started', $2)`,
        [session.id, JSON.stringify({ title, emergency, targetDevices })]
      );

      await client.query('COMMIT');
      return session;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * End an active session
   */
  async endSession(sessionId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Update session end time (triggers duration calculation)
      const result = await client.query(
        `UPDATE live_sessions
         SET ended_at = NOW(),
             status = 'ended'
         WHERE id = $1 AND status = 'active'
         RETURNING *`,
        [sessionId]
      );

      if (result.rows.length === 0) {
        throw new Error('Session not found or already ended');
      }

      // End all active viewers
      await client.query(
        `UPDATE live_session_viewers
         SET left_at = NOW()
         WHERE session_id = $1 AND left_at IS NULL`,
        [sessionId]
      );

      // Log event
      await client.query(
        `INSERT INTO live_session_events (session_id, event_type)
         VALUES ($1, 'ended')`,
        [sessionId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Get active session for a user
   */
  async getActiveSession(userId) {
    const result = await pool.query(
      `SELECT * FROM live_sessions
       WHERE user_id = $1 AND status = 'active'
       ORDER BY started_at DESC
       LIMIT 1`,
      [userId]
    );

    return result.rows[0] || null;
  },

  /**
   * Get session by ID
   */
  async getSessionById(sessionId) {
    const result = await pool.query(
      `SELECT * FROM live_sessions WHERE id = $1`,
      [sessionId]
    );

    return result.rows[0] || null;
  },

  /**
   * Get session history for a user
   */
  async getSessionHistory(userId, limit = 50, offset = 0) {
    const result = await pool.query(
      `SELECT * FROM live_sessions
       WHERE user_id = $1
       ORDER BY started_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM live_sessions WHERE user_id = $1`,
      [userId]
    );

    return {
      sessions: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset
    };
  },

  /**
   * Add viewer to session
   */
  async addViewer(sessionId, displayId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Add viewer record
      const viewerResult = await client.query(
        `INSERT INTO live_session_viewers (session_id, display_id, joined_at)
         VALUES ($1, $2, NOW())
         RETURNING *`,
        [sessionId, displayId]
      );

      // Update viewer count
      const countResult = await client.query(
        `SELECT COUNT(*) as count FROM live_session_viewers
         WHERE session_id = $1 AND left_at IS NULL`,
        [sessionId]
      );

      const currentCount = parseInt(countResult.rows[0].count);

      await client.query(
        `UPDATE live_sessions
         SET viewer_count = $1,
             peak_viewer_count = GREATEST(peak_viewer_count, $1)
         WHERE id = $2`,
        [currentCount, sessionId]
      );

      // Log event
      await client.query(
        `INSERT INTO live_session_events (session_id, event_type, event_data)
         VALUES ($1, 'viewer_joined', $2)`,
        [sessionId, JSON.stringify({ displayId, viewerCount: currentCount })]
      );

      await client.query('COMMIT');
      return {
        viewer: viewerResult.rows[0],
        viewerCount: currentCount
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Remove viewer from session
   */
  async removeViewer(sessionId, displayId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Update viewer left time (triggers watch duration calculation)
      await client.query(
        `UPDATE live_session_viewers
         SET left_at = NOW()
         WHERE session_id = $1 AND display_id = $2 AND left_at IS NULL`,
        [sessionId, displayId]
      );

      // Update viewer count
      const countResult = await pool.query(
        `SELECT COUNT(*) as count FROM live_session_viewers
         WHERE session_id = $1 AND left_at IS NULL`,
        [sessionId]
      );

      const currentCount = parseInt(countResult.rows[0].count);

      await client.query(
        `UPDATE live_sessions
         SET viewer_count = $1
         WHERE id = $2`,
        [currentCount, sessionId]
      );

      // Log event
      await client.query(
        `INSERT INTO live_session_events (session_id, event_type, event_data)
         VALUES ($1, 'viewer_left', $2)`,
        [sessionId, JSON.stringify({ displayId, viewerCount: currentCount })]
      );

      await client.query('COMMIT');
      return { viewerCount: currentCount };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Update recording URL after upload
   */
  async updateRecording(sessionId, recordingUrl, recordingPublicId, thumbnailUrl) {
    const result = await pool.query(
      `UPDATE live_sessions
       SET recording_url = $1,
           recording_public_id = $2,
           thumbnail_url = $3,
           status = 'ended'
       WHERE id = $4
       RETURNING *`,
      [recordingUrl, recordingPublicId, thumbnailUrl, sessionId]
    );

    // Log event
    await pool.query(
      `INSERT INTO live_session_events (session_id, event_type, event_data)
       VALUES ($1, 'recording_uploaded', $2)`,
      [sessionId, JSON.stringify({ recordingUrl, thumbnailUrl })]
    );

    return result.rows[0];
  },

  /**
   * Get session analytics
   */
  async getSessionAnalytics(sessionId) {
    const session = await this.getSessionById(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    // Get viewer details
    const viewersResult = await pool.query(
      `SELECT
         lsv.*,
         d.name as device_name,
         d.serial_number
       FROM live_session_viewers lsv
       JOIN displays d ON d.id = lsv.display_id
       WHERE lsv.session_id = $1
       ORDER BY lsv.joined_at`,
      [sessionId]
    );

    // Calculate average watch time
    const avgWatchResult = await pool.query(
      `SELECT AVG(watch_duration_seconds) as avg_watch_time
       FROM live_session_viewers
       WHERE session_id = $1 AND watch_duration_seconds IS NOT NULL`,
      [sessionId]
    );

    // Get event timeline
    const eventsResult = await pool.query(
      `SELECT * FROM live_session_events
       WHERE session_id = $1
       ORDER BY created_at`,
      [sessionId]
    );

    return {
      session,
      viewers: viewersResult.rows,
      totalViewers: viewersResult.rows.length,
      peakViewers: session.peak_viewer_count,
      averageWatchTime: Math.round(avgWatchResult.rows[0].avg_watch_time || 0),
      events: eventsResult.rows
    };
  },

  /**
   * Log session event
   */
  async logEvent(sessionId, eventType, eventData = null) {
    await pool.query(
      `INSERT INTO live_session_events (session_id, event_type, event_data)
       VALUES ($1, $2, $3)`,
      [sessionId, eventType, eventData ? JSON.stringify(eventData) : null]
    );
  },

  /**
   * Check if user has active emergency broadcast
   */
  async getActiveEmergencyBroadcast(userId) {
    const result = await pool.query(
      `SELECT * FROM live_sessions
       WHERE user_id = $1
       AND status = 'active'
       AND emergency = true
       LIMIT 1`,
      [userId]
    );

    return result.rows[0] || null;
  },

  /**
   * Get targeted devices for session
   */
  async getTargetedDevices(sessionId) {
    const result = await pool.query(
      `SELECT
         lst.*,
         d.name as device_name,
         d.serial_number
       FROM live_session_targets lst
       JOIN displays d ON d.id = lst.display_id
       WHERE lst.session_id = $1`,
      [sessionId]
    );

    return result.rows;
  },

  /**
   * Check if device is targeted for session
   */
  async isDeviceTargeted(sessionId, displayId) {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM live_session_targets
       WHERE session_id = $1 AND display_id = $2`,
      [sessionId, displayId]
    );

    return parseInt(result.rows[0].count) > 0;
  },

  /**
   * Get all user's displays
   */
  async getUserDevices(userId) {
    const result = await pool.query(
      `SELECT * FROM displays WHERE user_id = $1 AND is_paired = true`,
      [userId]
    );

    return result.rows;
  }
};

module.exports = liveSessionDb;
