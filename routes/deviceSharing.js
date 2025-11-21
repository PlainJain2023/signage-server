/**
 * Device Sharing Routes (Pro Tier Feature)
 * Allows users to share devices with other users with permission levels
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');
const { canShareDevices } = require('../middleware/tierCheck');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════
// DEVICE SHARING ENDPOINTS
// ═══════════════════════════════════════════════════════════

/**
 * Share a device with another user
 * POST /api/devices/:id/share
 * Requires: Pro tier or higher
 */
router.post('/:id/share', authenticateToken, canShareDevices, async (req, res) => {
  try {
    const { id: deviceId } = req.params;
    const { email, permissionLevel, message } = req.body;
    const userId = req.user.userId;

    // Validate input
    if (!email || !permissionLevel) {
      return res.status(400).json({
        error: 'Email and permission level are required'
      });
    }

    // Validate permission level
    const validPermissions = ['editor', 'viewer'];
    if (!validPermissions.includes(permissionLevel)) {
      return res.status(400).json({
        error: 'Invalid permission level. Must be "editor" or "viewer"'
      });
    }

    // Verify device ownership
    const deviceResult = await pool.query(
      'SELECT * FROM displays WHERE id = $1 AND (user_id = $2 OR owner_user_id = $2)',
      [deviceId, userId]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Device not found or you do not own this device'
      });
    }

    const device = deviceResult.rows[0];

    // Check if user exists
    const userResult = await pool.query(
      'SELECT id, email, name FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      // User doesn't exist - create an invitation
      const invitationToken = crypto.randomBytes(32).toString('hex');

      await pool.query(`
        INSERT INTO invitations (
          invited_email, invited_by_user_id, device_id,
          permission_level, invitation_token, message
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [email.toLowerCase(), userId, deviceId, permissionLevel, invitationToken, message || null]);

      return res.json({
        success: true,
        message: 'Invitation sent. User will receive access when they sign up.',
        invitationSent: true,
        invitationToken
      });
    }

    const targetUser = userResult.rows[0];

    // Check if already shared
    const existingPermission = await pool.query(
      'SELECT * FROM device_permissions WHERE device_id = $1 AND user_id = $2',
      [deviceId, targetUser.id]
    );

    if (existingPermission.rows.length > 0) {
      // Update existing permission
      await pool.query(`
        UPDATE device_permissions
        SET permission_level = $1, granted_by = $2, granted_at = NOW()
        WHERE device_id = $3 AND user_id = $4
      `, [permissionLevel, userId, deviceId, targetUser.id]);

      return res.json({
        success: true,
        message: `Updated ${targetUser.name}'s permission to ${permissionLevel}`,
        permission: {
          userId: targetUser.id,
          userName: targetUser.name,
          email: targetUser.email,
          permissionLevel
        }
      });
    }

    // Create new permission
    const result = await pool.query(`
      INSERT INTO device_permissions (
        device_id, user_id, permission_level, granted_by
      ) VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [deviceId, targetUser.id, permissionLevel, userId]);

    console.log(`✅ Device shared: ${device.device_name} with ${targetUser.email} (${permissionLevel})`);

    res.json({
      success: true,
      message: `Device shared with ${targetUser.name}`,
      permission: {
        id: result.rows[0].id,
        userId: targetUser.id,
        userName: targetUser.name,
        email: targetUser.email,
        permissionLevel,
        grantedAt: result.rows[0].granted_at
      }
    });

  } catch (error) {
    console.error('Error sharing device:', error);
    res.status(500).json({ error: 'Failed to share device' });
  }
});

/**
 * Get all users who have access to a device
 * GET /api/devices/:id/permissions
 */
router.get('/:id/permissions', authenticateToken, async (req, res) => {
  try {
    const { id: deviceId } = req.params;
    const userId = req.user.userId;

    // Verify device access (owner or has permission)
    const deviceResult = await pool.query(`
      SELECT d.* FROM displays d
      LEFT JOIN device_permissions dp ON d.id = dp.device_id AND dp.user_id = $2
      WHERE d.id = $1 AND (d.user_id = $2 OR d.owner_user_id = $2 OR dp.user_id = $2)
    `, [deviceId, userId]);

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found or access denied' });
    }

    // Get all permissions for this device
    const permissions = await pool.query(`
      SELECT
        dp.*,
        u.email,
        u.name as user_name,
        granted_by_user.name as granted_by_name
      FROM device_permissions dp
      JOIN users u ON dp.user_id = u.id
      LEFT JOIN users granted_by_user ON dp.granted_by = granted_by_user.id
      WHERE dp.device_id = $1
      ORDER BY dp.granted_at DESC
    `, [deviceId]);

    res.json({
      success: true,
      permissions: permissions.rows.map(p => ({
        id: p.id,
        userId: p.user_id,
        userName: p.user_name,
        email: p.email,
        permissionLevel: p.permission_level,
        grantedBy: p.granted_by_name,
        grantedAt: p.granted_at,
        expiresAt: p.expires_at
      }))
    });

  } catch (error) {
    console.error('Error fetching permissions:', error);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
});

/**
 * Revoke device access from a user
 * DELETE /api/devices/:id/share/:userId
 */
router.delete('/:id/share/:targetUserId', authenticateToken, async (req, res) => {
  try {
    const { id: deviceId, targetUserId } = req.params;
    const userId = req.user.userId;

    // Verify device ownership
    const deviceResult = await pool.query(
      'SELECT * FROM displays WHERE id = $1 AND (user_id = $2 OR owner_user_id = $2)',
      [deviceId, userId]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Device not found or you do not own this device'
      });
    }

    // Delete permission
    const result = await pool.query(
      'DELETE FROM device_permissions WHERE device_id = $1 AND user_id = $2 RETURNING *',
      [deviceId, targetUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Permission not found'
      });
    }

    console.log(`🗑️ Access revoked: Device ${deviceId} from user ${targetUserId}`);

    res.json({
      success: true,
      message: 'Access revoked successfully'
    });

  } catch (error) {
    console.error('Error revoking access:', error);
    res.status(500).json({ error: 'Failed to revoke access' });
  }
});

/**
 * Get all devices shared with me
 * GET /api/devices/shared-with-me
 */
router.get('/shared-with-me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(`
      SELECT
        d.*,
        dp.permission_level,
        dp.granted_at,
        owner.name as owner_name,
        owner.email as owner_email
      FROM device_permissions dp
      JOIN displays d ON dp.device_id = d.id
      JOIN users owner ON d.owner_user_id = owner.id
      WHERE dp.user_id = $1
      ORDER BY dp.granted_at DESC
    `, [userId]);

    res.json({
      success: true,
      devices: result.rows.map(d => ({
        id: d.id,
        serialNumber: d.serial_number,
        deviceName: d.device_name,
        location: d.location,
        status: d.status,
        permissionLevel: d.permission_level,
        sharedAt: d.granted_at,
        owner: {
          name: d.owner_name,
          email: d.owner_email
        }
      }))
    });

  } catch (error) {
    console.error('Error fetching shared devices:', error);
    res.status(500).json({ error: 'Failed to fetch shared devices' });
  }
});

module.exports = router;
