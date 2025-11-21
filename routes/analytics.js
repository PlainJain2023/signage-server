/**
 * Analytics Routes (Enterprise Tier Feature)
 * Provides usage analytics and audit logs
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');
const { canAccessAnalytics } = require('../middleware/tierCheck');

// ═══════════════════════════════════════════════════════════
// ANALYTICS ENDPOINTS
// ═══════════════════════════════════════════════════════════

/**
 * Get display analytics (what was shown, when, where)
 * GET /api/analytics/displays
 * Requires: Enterprise tier
 */
router.get('/displays', authenticateToken, canAccessAnalytics, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { deviceId, startDate, endDate, limit = 100 } = req.query;

    let query = `
      SELECT
        da.*,
        d.device_name,
        d.serial_number,
        s.image_title
      FROM display_analytics da
      LEFT JOIN displays d ON da.device_id = d.id
      LEFT JOIN schedules s ON da.schedule_id = s.id
      WHERE da.user_id = $1
    `;
    const params = [userId];

    if (deviceId) {
      params.push(deviceId);
      query += ` AND da.device_id = $${params.length}`;
    }

    if (startDate) {
      params.push(startDate);
      query += ` AND da.displayed_at >= $${params.length}`;
    }

    if (endDate) {
      params.push(endDate);
      query += ` AND da.displayed_at <= $${params.length}`;
    }

    query += ` ORDER BY da.displayed_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      analytics: result.rows.map(row => ({
        id: row.id,
        deviceName: row.device_name,
        serialNumber: row.serial_number,
        contentTitle: row.image_title,
        contentUrl: row.content_url,
        displayedAt: row.displayed_at,
        durationScheduled: row.duration_scheduled,
        durationActual: row.duration_actual
      }))
    });

  } catch (error) {
    console.error('Error fetching display analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

/**
 * Get audit logs (security and compliance)
 * GET /api/analytics/audit-logs
 * Requires: Enterprise tier
 */
router.get('/audit-logs', authenticateToken, canAccessAnalytics, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { action, resourceType, startDate, endDate, limit = 100 } = req.query;

    let query = `
      SELECT
        al.*,
        u.name as user_name,
        u.email as user_email
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE (al.user_id = $1 OR al.org_id IN (
        SELECT org_id FROM org_members WHERE user_id = $1
      ))
    `;
    const params = [userId];

    if (action) {
      params.push(action);
      query += ` AND al.action = $${params.length}`;
    }

    if (resourceType) {
      params.push(resourceType);
      query += ` AND al.resource_type = $${params.length}`;
    }

    if (startDate) {
      params.push(startDate);
      query += ` AND al.created_at >= $${params.length}`;
    }

    if (endDate) {
      params.push(endDate);
      query += ` AND al.created_at <= $${params.length}`;
    }

    query += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      logs: result.rows.map(log => ({
        id: log.id,
        userName: log.user_name,
        userEmail: log.user_email,
        action: log.action,
        resourceType: log.resource_type,
        resourceId: log.resource_id,
        oldValues: log.old_values,
        newValues: log.new_values,
        ipAddress: log.ip_address,
        createdAt: log.created_at
      }))
    });

  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

/**
 * Get device statistics
 * GET /api/analytics/device-stats
 * Requires: Enterprise tier
 */
router.get('/device-stats', authenticateToken, canAccessAnalytics, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { deviceId, days = 30 } = req.query;

    let query = `
      SELECT
        das.*,
        d.device_name,
        d.serial_number
      FROM device_analytics das
      JOIN displays d ON das.device_id = d.id
      WHERE d.user_id = $1 OR d.owner_user_id = $1
    `;
    const params = [userId];

    if (deviceId) {
      params.push(deviceId);
      query += ` AND das.device_id = $${params.length}`;
    }

    params.push(days);
    query += ` AND das.stats_date >= CURRENT_DATE - INTERVAL '${days} days'`;
    query += ` ORDER BY das.stats_date DESC`;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      deviceStats: result.rows.map(stat => ({
        deviceId: stat.device_id,
        deviceName: stat.device_name,
        serialNumber: stat.serial_number,
        date: stat.stats_date,
        contentDisplayed: stat.content_displayed_count,
        uptime: stat.uptime_minutes,
        avgResponseTime: stat.avg_response_time_ms
      }))
    });

  } catch (error) {
    console.error('Error fetching device stats:', error);
    res.status(500).json({ error: 'Failed to fetch device statistics' });
  }
});

/**
 * Get user statistics summary
 * GET /api/analytics/user-summary
 * Requires: Enterprise tier
 */
router.get('/user-summary', authenticateToken, canAccessAnalytics, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { days = 30 } = req.query;

    const result = await pool.query(`
      SELECT
        uas.*
      FROM user_analytics uas
      WHERE uas.user_id = $1
        AND uas.stats_date >= CURRENT_DATE - INTERVAL '${parseInt(days)} days'
      ORDER BY uas.stats_date DESC
    `, [userId]);

    // Get totals
    const totals = {
      totalSchedulesCreated: 0,
      totalContentDisplayedCount: 0,
      totalDevicesActive: 0
    };

    result.rows.forEach(row => {
      totals.totalSchedulesCreated += row.schedules_created || 0;
      totals.totalContentDisplayedCount += row.content_displayed_count || 0;
      totals.totalDevicesActive += row.devices_active_count || 0;
    });

    res.json({
      success: true,
      summary: {
        period: `Last ${days} days`,
        totals,
        daily: result.rows.map(row => ({
          date: row.stats_date,
          schedulesCreated: row.schedules_created,
          contentDisplayed: row.content_displayed_count,
          devicesActive: row.devices_active_count
        }))
      }
    });

  } catch (error) {
    console.error('Error fetching user summary:', error);
    res.status(500).json({ error: 'Failed to fetch user summary' });
  }
});

/**
 * Get organization analytics
 * GET /api/analytics/organization/:orgId
 * Requires: Enterprise tier + Org membership
 */
router.get('/organization/:orgId', authenticateToken, canAccessAnalytics, async (req, res) => {
  try {
    const { orgId } = req.params;
    const userId = req.user.userId;
    const { days = 30 } = req.query;

    // Verify org membership
    const memberResult = await pool.query(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const result = await pool.query(`
      SELECT
        oas.*
      FROM org_analytics oas
      WHERE oas.org_id = $1
        AND oas.stats_date >= CURRENT_DATE - INTERVAL '${parseInt(days)} days'
      ORDER BY oas.stats_date DESC
    `, [orgId]);

    res.json({
      success: true,
      analytics: result.rows.map(row => ({
        date: row.stats_date,
        totalMembers: row.total_members,
        activeDevices: row.active_devices,
        contentDeployed: row.content_deployed_count,
        campaignsLaunched: row.campaigns_launched
      }))
    });

  } catch (error) {
    console.error('Error fetching org analytics:', error);
    res.status(500).json({ error: 'Failed to fetch organization analytics' });
  }
});

module.exports = router;
