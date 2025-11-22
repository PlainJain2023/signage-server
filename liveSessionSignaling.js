/**
 * Live Session WebRTC Signaling Server
 * Handles WebRTC peer connection setup via Socket.IO
 */

const liveSessionDb = require('./liveSessionDb');

// Store active broadcast sessions
// sessionId -> { broadcaster: socketId, broadcasterUserId, viewers: Map<socketId, displayId> }
const activeSessions = new Map();

// Store socket to device/user mappings
// socketId -> { type: 'broadcaster'|'display', userId, displayId }
const socketMappings = new Map();

/**
 * Setup live session signaling handlers
 * @param {SocketIO.Server} io - Socket.IO server instance
 */
function setupLiveSignaling(io) {

  io.on('connection', (socket) => {
    console.log('✅ Client connected:', socket.id);

    // =============================================
    // BROADCASTER EVENTS
    // =============================================

    /**
     * Broadcaster starts a live session
     */
    socket.on('live:start-broadcast', async ({ sessionId, userId }) => {
      try {
        console.log(`📡 Broadcast started: Session ${sessionId} by user ${userId}`);

        // Verify session exists and belongs to user
        const session = await liveSessionDb.getSessionById(sessionId);
        if (!session || session.user_id !== userId) {
          socket.emit('live:error', { error: 'Invalid session' });
          return;
        }

        // Store session info
        activeSessions.set(sessionId, {
          broadcaster: socket.id,
          broadcasterUserId: userId,
          viewers: new Map(),
          startedAt: Date.now()
        });

        // Map socket to user
        socketMappings.set(socket.id, {
          type: 'broadcaster',
          userId,
          sessionId
        });

        // Join session room
        socket.join(`session-${sessionId}`);
        socket.join(`broadcaster-${userId}`);

        // Get user's devices
        const devices = await liveSessionDb.getUserDevices(userId);

        // Check if specific devices were targeted
        const targetedDevices = await liveSessionDb.getTargetedDevices(sessionId);
        let devicesToNotify = devices;

        if (targetedDevices.length > 0) {
          const targetedIds = targetedDevices.map(t => t.display_id);
          devicesToNotify = devices.filter(d => targetedIds.includes(d.id));
        }

        console.log(`📢 Notifying ${devicesToNotify.length} devices`);

        // Notify all targeted displays
        devicesToNotify.forEach(device => {
          io.to(`device-${device.id}`).emit('live:broadcast-started', {
            sessionId: session.id,
            title: session.title,
            userId: session.user_id,
            emergency: session.emergency,
            startedAt: session.started_at
          });
        });

        // Confirm to broadcaster
        socket.emit('live:broadcast-ready', {
          sessionId,
          devicesNotified: devicesToNotify.length
        });

      } catch (error) {
        console.error('❌ Error starting broadcast:', error);
        socket.emit('live:error', {
          error: 'Failed to start broadcast',
          details: error.message
        });
      }
    });

    /**
     * Broadcaster ends the session
     */
    socket.on('live:end-broadcast', async ({ sessionId }) => {
      try {
        console.log(`🛑 Broadcast ending: Session ${sessionId}`);

        const session = activeSessions.get(sessionId);
        if (!session || session.broadcaster !== socket.id) {
          socket.emit('live:error', { error: 'Not authorized' });
          return;
        }

        // Notify all viewers that broadcast ended
        io.to(`session-${sessionId}`).emit('live:broadcast-ended', {
          sessionId,
          reason: 'Broadcaster ended session'
        });

        // Update database
        await liveSessionDb.endSession(sessionId);

        // Clean up
        activeSessions.delete(sessionId);
        socketMappings.delete(socket.id);

        console.log(`✅ Broadcast ended: Session ${sessionId}`);

      } catch (error) {
        console.error('❌ Error ending broadcast:', error);
        socket.emit('live:error', {
          error: 'Failed to end broadcast',
          details: error.message
        });
      }
    });

    // =============================================
    // DISPLAY (VIEWER) EVENTS
    // =============================================

    /**
     * Display registers to receive broadcasts
     */
    socket.on('display-register', async ({ displayId, serialNumber }) => {
      try {
        console.log(`📺 Display registered: Device ${displayId} (${serialNumber})`);

        socket.join(`device-${displayId}`);

        // Store mapping
        socketMappings.set(socket.id, {
          type: 'display',
          displayId,
          serialNumber
        });

        // Check if there's an active emergency broadcast for this display's user
        // (Displays need to join emergency broadcasts immediately on connect)
        const { pool } = require('./database');
        const displayResult = await pool.query(
          'SELECT user_id FROM displays WHERE id = $1',
          [displayId]
        );

        if (displayResult.rows.length > 0) {
          const userId = displayResult.rows[0].user_id;
          const emergencySession = await liveSessionDb.getActiveEmergencyBroadcast(userId);

          if (emergencySession) {
            socket.emit('live:emergency-override', {
              sessionId: emergencySession.id,
              title: emergencySession.title,
              startedAt: emergencySession.started_at
            });
          }
        }

      } catch (error) {
        console.error('❌ Error registering display:', error);
      }
    });

    /**
     * Viewer (display) joins a broadcast session
     */
    socket.on('live:join-session', async ({ sessionId, displayId }) => {
      try {
        console.log(`👀 Viewer joining: Device ${displayId} → Session ${sessionId}`);

        const session = activeSessions.get(sessionId);
        if (!session) {
          socket.emit('live:error', { error: 'Session not found or not active' });
          return;
        }

        // Add viewer to session
        session.viewers.set(socket.id, displayId);
        socket.join(`session-${sessionId}`);

        // Update database and get viewer count
        const result = await liveSessionDb.addViewer(sessionId, displayId);

        // Notify broadcaster
        io.to(session.broadcaster).emit('live:viewer-joined', {
          sessionId,
          displayId,
          viewerId: socket.id,
          viewerCount: result.viewerCount
        });

        // Notify viewer they're ready for WebRTC offer
        socket.emit('live:viewer-ready', {
          sessionId,
          broadcasterId: session.broadcaster
        });

        console.log(`✅ Viewer joined: ${result.viewerCount} viewers in session ${sessionId}`);

      } catch (error) {
        console.error('❌ Error joining session:', error);
        socket.emit('live:error', {
          error: 'Failed to join session',
          details: error.message
        });
      }
    });

    /**
     * Viewer leaves session
     */
    socket.on('live:leave-session', async ({ sessionId, displayId }) => {
      try {
        console.log(`👋 Viewer leaving: Device ${displayId} → Session ${sessionId}`);

        const session = activeSessions.get(sessionId);
        if (!session) return;

        // Remove viewer
        session.viewers.delete(socket.id);
        socket.leave(`session-${sessionId}`);

        // Update database
        const result = await liveSessionDb.removeViewer(sessionId, displayId);

        // Notify broadcaster
        io.to(session.broadcaster).emit('live:viewer-left', {
          sessionId,
          displayId,
          viewerId: socket.id,
          viewerCount: result.viewerCount
        });

      } catch (error) {
        console.error('❌ Error leaving session:', error);
      }
    });

    // =============================================
    // WEBRTC SIGNALING EVENTS
    // =============================================

    /**
     * Forward WebRTC offer from broadcaster to viewer
     */
    socket.on('live:offer', ({ sessionId, viewerId, offer }) => {
      console.log(`📤 Forwarding offer: ${socket.id} → ${viewerId}`);

      io.to(viewerId).emit('live:offer', {
        sessionId,
        broadcasterId: socket.id,
        offer
      });
    });

    /**
     * Forward WebRTC answer from viewer to broadcaster
     */
    socket.on('live:answer', ({ sessionId, broadcasterId, answer }) => {
      console.log(`📤 Forwarding answer: ${socket.id} → ${broadcasterId}`);

      io.to(broadcasterId).emit('live:answer', {
        sessionId,
        viewerId: socket.id,
        answer
      });
    });

    /**
     * Forward ICE candidates between peers
     */
    socket.on('live:ice-candidate', ({ sessionId, targetId, candidate }) => {
      if (targetId) {
        io.to(targetId).emit('live:ice-candidate', {
          sessionId,
          senderId: socket.id,
          candidate
        });
      }
    });

    // =============================================
    // CONNECTION QUALITY MONITORING
    // =============================================

    /**
     * Viewer reports connection quality
     */
    socket.on('live:quality-report', async ({ sessionId, displayId, quality, stats }) => {
      try {
        // Update viewer quality in database
        const { pool } = require('./database');
        await pool.query(
          `UPDATE live_session_viewers
           SET connection_quality = $1
           WHERE session_id = $2 AND display_id = $3 AND left_at IS NULL`,
          [quality, sessionId, displayId]
        );

        // Log quality event if poor
        if (quality === 'poor' || quality === 'fair') {
          await liveSessionDb.logEvent(sessionId, 'quality_degraded', {
            displayId,
            quality,
            stats
          });

          // Notify broadcaster
          const session = activeSessions.get(sessionId);
          if (session) {
            io.to(session.broadcaster).emit('live:quality-warning', {
              displayId,
              quality,
              stats
            });
          }
        }

      } catch (error) {
        console.error('❌ Error reporting quality:', error);
      }
    });

    // =============================================
    // ERROR HANDLING
    // =============================================

    /**
     * Handle connection errors
     */
    socket.on('live:error-report', async ({ sessionId, error, context }) => {
      try {
        console.error('⚠️  Client reported error:', error);

        await liveSessionDb.logEvent(sessionId, 'error', {
          error,
          context,
          socketId: socket.id
        });

      } catch (err) {
        console.error('❌ Error logging client error:', err);
      }
    });

    // =============================================
    // DISCONNECTION HANDLING
    // =============================================

    socket.on('disconnect', async () => {
      console.log('❌ Client disconnected:', socket.id);

      const mapping = socketMappings.get(socket.id);
      if (!mapping) return;

      try {
        if (mapping.type === 'broadcaster') {
          // Broadcaster disconnected - end all their sessions
          for (const [sessionId, session] of activeSessions.entries()) {
            if (session.broadcaster === socket.id) {
              console.log(`🛑 Broadcaster disconnected, ending session ${sessionId}`);

              // Notify all viewers
              io.to(`session-${sessionId}`).emit('live:broadcast-ended', {
                sessionId,
                reason: 'Broadcaster disconnected'
              });

              // Update database
              await liveSessionDb.endSession(sessionId);

              // Clean up
              activeSessions.delete(sessionId);
            }
          }

        } else if (mapping.type === 'display') {
          // Viewer disconnected - remove from active sessions
          for (const [sessionId, session] of activeSessions.entries()) {
            if (session.viewers.has(socket.id)) {
              const displayId = session.viewers.get(socket.id);

              console.log(`👋 Viewer ${displayId} disconnected from session ${sessionId}`);

              // Remove viewer
              session.viewers.delete(socket.id);

              // Update database
              const result = await liveSessionDb.removeViewer(sessionId, displayId);

              // Notify broadcaster
              io.to(session.broadcaster).emit('live:viewer-left', {
                sessionId,
                displayId,
                viewerId: socket.id,
                viewerCount: result.viewerCount,
                reason: 'disconnected'
              });
            }
          }
        }

        // Clean up mapping
        socketMappings.delete(socket.id);

      } catch (error) {
        console.error('❌ Error handling disconnect:', error);
      }
    });

  });

  // Return helper functions for external use
  return {
    getActiveSessions: () => activeSessions,
    getSocketMappings: () => socketMappings,

    /**
     * Force end a session (useful for admin operations)
     */
    forceEndSession: async (sessionId) => {
      const session = activeSessions.get(sessionId);
      if (!session) return false;

      io.to(`session-${sessionId}`).emit('live:broadcast-ended', {
        sessionId,
        reason: 'Session force ended by system'
      });

      await liveSessionDb.endSession(sessionId);
      activeSessions.delete(sessionId);

      return true;
    },

    /**
     * Get session statistics
     */
    getSessionStats: (sessionId) => {
      const session = activeSessions.get(sessionId);
      if (!session) return null;

      return {
        sessionId,
        broadcaster: session.broadcaster,
        viewerCount: session.viewers.size,
        viewers: Array.from(session.viewers.entries()).map(([socketId, displayId]) => ({
          socketId,
          displayId
        })),
        uptime: Math.floor((Date.now() - session.startedAt) / 1000)
      };
    }
  };
}

module.exports = { setupLiveSignaling };
