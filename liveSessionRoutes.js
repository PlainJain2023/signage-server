/**
 * Live Session API Routes
 * Handles all HTTP endpoints for live video broadcasting
 */

const liveSessionDb = require('./liveSessionDb');

/**
 * Setup live session routes
 * @param {Express} app - Express app instance
 * @param {Function} authenticateToken - Auth middleware
 * @param {Function} apiLimiter - Rate limiter middleware
 */
function setupLiveSessionRoutes(app, authenticateToken, apiLimiter) {

  // =============================================
  // POST /api/live/start
  // Start a new live broadcast session
  // =============================================
  app.post('/api/live/start', authenticateToken, apiLimiter, async (req, res) => {
    try {
      const { title, targetDisplays, emergency } = req.body;
      const userId = req.user.id;

      // Check if user already has an active session
      const existingSession = await liveSessionDb.getActiveSession(userId);
      if (existingSession) {
        return res.status(400).json({
          error: 'Active session already exists',
          sessionId: existingSession.id
        });
      }

      // Validate target displays if provided
      let displaysToTarget = [];
      if (targetDisplays && Array.isArray(targetDisplays) && targetDisplays.length > 0) {
        const userDisplays = await liveSessionDb.getUserDevices(userId);
        const userDisplayIds = userDisplays.map(d => d.id);

        // Ensure all target displays belong to this user
        displaysToTarget = targetDisplays.filter(id => userDisplayIds.includes(id));

        if (displaysToTarget.length === 0) {
          return res.status(400).json({
            error: 'No valid target displays found'
          });
        }
      }

      // Create session
      const session = await liveSessionDb.createSession(
        userId,
        title || 'Live Announcement',
        emergency || false,
        displaysToTarget
      );

      res.json({
        success: true,
        sessionId: session.id,
        startedAt: session.started_at,
        status: session.status,
        emergency: session.emergency,
        targetedDisplays: displaysToTarget.length || 'all'
      });

    } catch (error) {
      console.error('Error starting live session:', error);
      res.status(500).json({
        error: 'Failed to start live session',
        details: error.message
      });
    }
  });

  // =============================================
  // POST /api/live/:sessionId/end
  // End an active broadcast
  // =============================================
  app.post('/api/live/:sessionId/end', authenticateToken, apiLimiter, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const userId = req.user.id;

      // Get session and verify ownership
      const session = await liveSessionDb.getSessionById(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.user_id !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      if (session.status !== 'active') {
        return res.status(400).json({
          error: 'Session is not active',
          status: session.status
        });
      }

      // End session
      const updatedSession = await liveSessionDb.endSession(sessionId);

      res.json({
        success: true,
        sessionId: updatedSession.id,
        endedAt: updatedSession.ended_at,
        duration: updatedSession.duration_seconds,
        viewerCount: updatedSession.viewer_count,
        peakViewerCount: updatedSession.peak_viewer_count,
        recordingUrl: updatedSession.recording_url
      });

    } catch (error) {
      console.error('Error ending live session:', error);
      res.status(500).json({
        error: 'Failed to end live session',
        details: error.message
      });
    }
  });

  // =============================================
  // GET /api/live/active
  // Get current active broadcast (if any)
  // =============================================
  app.get('/api/live/active', authenticateToken, apiLimiter, async (req, res) => {
    try {
      const userId = req.user.id;

      const session = await liveSessionDb.getActiveSession(userId);

      if (!session) {
        return res.json({
          active: false,
          session: null
        });
      }

      // Calculate current duration
      const startTime = new Date(session.started_at);
      const currentDuration = Math.floor((Date.now() - startTime.getTime()) / 1000);

      res.json({
        active: true,
        session: {
          id: session.id,
          title: session.title,
          startedAt: session.started_at,
          duration: currentDuration,
          viewerCount: session.viewer_count,
          peakViewerCount: session.peak_viewer_count,
          emergency: session.emergency,
          status: session.status
        }
      });

    } catch (error) {
      console.error('Error getting active session:', error);
      res.status(500).json({
        error: 'Failed to get active session',
        details: error.message
      });
    }
  });

  // =============================================
  // GET /api/live/history
  // Get past broadcasts with recordings
  // =============================================
  app.get('/api/live/history', authenticateToken, apiLimiter, async (req, res) => {
    try {
      const userId = req.user.id;
      const limit = parseInt(req.query.limit) || 50;
      const offset = parseInt(req.query.offset) || 0;

      const result = await liveSessionDb.getSessionHistory(userId, limit, offset);

      res.json({
        success: true,
        sessions: result.sessions.map(session => ({
          id: session.id,
          title: session.title,
          startedAt: session.started_at,
          endedAt: session.ended_at,
          duration: session.duration_seconds,
          viewerCount: session.viewer_count,
          peakViewerCount: session.peak_viewer_count,
          emergency: session.emergency,
          recordingUrl: session.recording_url,
          thumbnailUrl: session.thumbnail_url,
          status: session.status
        })),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: (result.offset + result.limit) < result.total
      });

    } catch (error) {
      console.error('Error getting session history:', error);
      res.status(500).json({
        error: 'Failed to get session history',
        details: error.message
      });
    }
  });

  // =============================================
  // GET /api/live/:sessionId
  // Get details for a specific session
  // =============================================
  app.get('/api/live/:sessionId', authenticateToken, apiLimiter, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const userId = req.user.id;

      const session = await liveSessionDb.getSessionById(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.user_id !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      res.json({
        success: true,
        session: {
          id: session.id,
          title: session.title,
          startedAt: session.started_at,
          endedAt: session.ended_at,
          duration: session.duration_seconds,
          viewerCount: session.viewer_count,
          peakViewerCount: session.peak_viewer_count,
          emergency: session.emergency,
          recordingUrl: session.recording_url,
          thumbnailUrl: session.thumbnail_url,
          status: session.status
        }
      });

    } catch (error) {
      console.error('Error getting session:', error);
      res.status(500).json({
        error: 'Failed to get session',
        details: error.message
      });
    }
  });

  // =============================================
  // GET /api/live/:sessionId/analytics
  // Get detailed analytics for a session
  // =============================================
  app.get('/api/live/:sessionId/analytics', authenticateToken, apiLimiter, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const userId = req.user.id;

      const session = await liveSessionDb.getSessionById(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.user_id !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      const analytics = await liveSessionDb.getSessionAnalytics(sessionId);

      res.json({
        success: true,
        analytics: {
          session: {
            id: analytics.session.id,
            title: analytics.session.title,
            startedAt: analytics.session.started_at,
            endedAt: analytics.session.ended_at,
            duration: analytics.session.duration_seconds
          },
          metrics: {
            totalViewers: analytics.totalViewers,
            peakViewers: analytics.peakViewers,
            averageWatchTime: analytics.averageWatchTime
          },
          viewers: analytics.viewers.map(v => ({
            displayId: v.display_id,
            displayName: v.device_name,
            serialNumber: v.serial_number,
            joinedAt: v.joined_at,
            leftAt: v.left_at,
            watchDuration: v.watch_duration_seconds,
            connectionQuality: v.connection_quality
          })),
          timeline: analytics.events.map(e => ({
            type: e.event_type,
            timestamp: e.created_at,
            data: e.event_data
          }))
        }
      });

    } catch (error) {
      console.error('Error getting session analytics:', error);
      res.status(500).json({
        error: 'Failed to get session analytics',
        details: error.message
      });
    }
  });

  // =============================================
  // DELETE /api/live/:sessionId
  // Delete a session and its recording
  // =============================================
  app.delete('/api/live/:sessionId', authenticateToken, apiLimiter, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const userId = req.user.id;
      const cloudinary = require('cloudinary').v2;

      const session = await liveSessionDb.getSessionById(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.user_id !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      // Delete recording from Cloudinary if exists
      if (session.recording_public_id) {
        try {
          await cloudinary.uploader.destroy(session.recording_public_id, {
            resource_type: 'video'
          });
        } catch (cloudinaryError) {
          console.error('Error deleting from Cloudinary:', cloudinaryError);
          // Continue with database deletion even if Cloudinary fails
        }
      }

      // Delete from database (cascade will delete related records)
      const { pool } = require('./database');
      await pool.query('DELETE FROM live_sessions WHERE id = $1', [sessionId]);

      res.json({
        success: true,
        message: 'Session deleted successfully'
      });

    } catch (error) {
      console.error('Error deleting session:', error);
      res.status(500).json({
        error: 'Failed to delete session',
        details: error.message
      });
    }
  });

  // =============================================
  // GET /api/live/emergency/active
  // Check if there's an active emergency broadcast
  // (Used by displays to check on connect)
  // =============================================
  app.get('/api/live/emergency/active', authenticateToken, apiLimiter, async (req, res) => {
    try {
      const userId = req.user.id;

      const emergencySession = await liveSessionDb.getActiveEmergencyBroadcast(userId);

      if (!emergencySession) {
        return res.json({
          active: false,
          session: null
        });
      }

      res.json({
        active: true,
        session: {
          id: emergencySession.id,
          title: emergencySession.title,
          startedAt: emergencySession.started_at,
          viewerCount: emergencySession.viewer_count
        }
      });

    } catch (error) {
      console.error('Error checking emergency broadcast:', error);
      res.status(500).json({
        error: 'Failed to check emergency broadcast',
        details: error.message
      });
    }
  });

}

module.exports = { setupLiveSessionRoutes };
