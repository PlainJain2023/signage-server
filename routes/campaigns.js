/**
 * Campaigns Routes (Enterprise Tier Feature)
 * Allows bulk scheduling to multiple devices with approval workflows
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');
const { canCreateCampaigns } = require('../middleware/tierCheck');

// ═══════════════════════════════════════════════════════════
// CAMPAIGN ENDPOINTS
// ═══════════════════════════════════════════════════════════

/**
 * Create a new campaign
 * POST /api/campaigns
 * Requires: Enterprise tier
 */
router.post('/', authenticateToken, canCreateCampaigns, async (req, res) => {
  try {
    const {
      name,
      description,
      orgId,
      deviceIds = [],
      playlistId,
      scheduledTime,
      requiresApproval = false
    } = req.body;
    const userId = req.user.userId;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Campaign name is required' });
    }

    if (deviceIds.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    // Verify org membership if orgId provided
    if (orgId) {
      const memberResult = await pool.query(
        'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
        [orgId, userId]
      );

      if (memberResult.rows.length === 0) {
        return res.status(403).json({ error: 'Not a member of this organization' });
      }
    }

    // Create campaign
    const campaignResult = await pool.query(`
      INSERT INTO campaigns (
        org_id, name, description, created_by, requires_approval, status
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [orgId || null, name.trim(), description || null, userId, requiresApproval, requiresApproval ? 'pending_approval' : 'draft']);

    const campaign = campaignResult.rows[0];

    // Add device targets
    for (const deviceId of deviceIds) {
      await pool.query(`
        INSERT INTO campaign_targets (campaign_id, device_id)
        VALUES ($1, $2)
      `, [campaign.id, deviceId]);
    }

    console.log(`✅ Campaign created: ${name} targeting ${deviceIds.length} devices`);

    res.json({
      success: true,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        description: campaign.description,
        status: campaign.status,
        requiresApproval: campaign.requires_approval,
        deviceCount: deviceIds.length,
        createdAt: campaign.created_at
      }
    });

  } catch (error) {
    console.error('Error creating campaign:', error);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

/**
 * Get all campaigns
 * GET /api/campaigns
 */
router.get('/', authenticateToken, canCreateCampaigns, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { orgId } = req.query;

    let query = `
      SELECT
        c.*,
        COUNT(DISTINCT ct.device_id) as device_count,
        u.name as created_by_name
      FROM campaigns c
      LEFT JOIN campaign_targets ct ON c.id = ct.campaign_id
      LEFT JOIN users u ON c.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (orgId) {
      params.push(orgId);
      query += ` AND c.org_id = $${params.length}`;
    } else {
      params.push(userId);
      query += ` AND c.created_by = $${params.length}`;
    }

    query += ' GROUP BY c.id, u.name ORDER BY c.created_at DESC';

    const result = await pool.query(query, params);

    res.json({
      success: true,
      campaigns: result.rows.map(c => ({
        id: c.id,
        name: c.name,
        description: c.description,
        status: c.status,
        requiresApproval: c.requires_approval,
        deviceCount: parseInt(c.device_count) || 0,
        createdBy: c.created_by_name,
        createdAt: c.created_at,
        launchedAt: c.launched_at
      }))
    });

  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

/**
 * Get specific campaign details
 * GET /api/campaigns/:id
 */
router.get('/:id', authenticateToken, canCreateCampaigns, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Get campaign
    const campaignResult = await pool.query(`
      SELECT c.*, u.name as created_by_name
      FROM campaigns c
      JOIN users u ON c.created_by = u.id
      WHERE c.id = $1
    `, [id]);

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignResult.rows[0];

    // Get target devices
    const targetsResult = await pool.query(`
      SELECT ct.*, d.device_name, d.serial_number
      FROM campaign_targets ct
      JOIN displays d ON ct.device_id = d.id
      WHERE ct.campaign_id = $1
    `, [id]);

    res.json({
      success: true,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        description: campaign.description,
        status: campaign.status,
        requiresApproval: campaign.requires_approval,
        approvedBy: campaign.approved_by,
        approvedAt: campaign.approved_at,
        createdBy: campaign.created_by_name,
        createdAt: campaign.created_at,
        launchedAt: campaign.launched_at,
        targets: targetsResult.rows.map(t => ({
          deviceId: t.device_id,
          deviceName: t.device_name,
          serialNumber: t.serial_number,
          deployedAt: t.deployed_at
        }))
      }
    });

  } catch (error) {
    console.error('Error fetching campaign:', error);
    res.status(500).json({ error: 'Failed to fetch campaign' });
  }
});

/**
 * Launch campaign
 * POST /api/campaigns/:id/launch
 */
router.post('/:id/launch', authenticateToken, canCreateCampaigns, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Get campaign
    const campaignResult = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND created_by = $2',
      [id, userId]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignResult.rows[0];

    // Check if approval required
    if (campaign.requires_approval && campaign.approval_status !== 'approved') {
      return res.status(403).json({ error: 'Campaign requires approval before launching' });
    }

    // Update campaign status
    await pool.query(`
      UPDATE campaigns
      SET status = 'active', launched_at = NOW()
      WHERE id = $1
    `, [id]);

    console.log(`🚀 Campaign launched: ${campaign.name}`);

    res.json({
      success: true,
      message: 'Campaign launched successfully'
    });

  } catch (error) {
    console.error('Error launching campaign:', error);
    res.status(500).json({ error: 'Failed to launch campaign' });
  }
});

/**
 * Approve campaign
 * POST /api/campaigns/:id/approve
 * Requires: Manager or Admin role in organization
 */
router.post('/:id/approve', authenticateToken, canCreateCampaigns, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Get campaign
    const campaignResult = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignResult.rows[0];

    if (!campaign.org_id) {
      return res.status(400).json({ error: 'Only organization campaigns require approval' });
    }

    // Verify manager/admin role
    const memberResult = await pool.query(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
      [campaign.org_id, userId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const role = memberResult.rows[0].role;
    if (role !== 'admin' && role !== 'manager') {
      return res.status(403).json({ error: 'Manager or Admin role required to approve campaigns' });
    }

    // Approve campaign
    await pool.query(`
      UPDATE campaigns
      SET approval_status = 'approved',
          approved_by = $1,
          approved_at = NOW(),
          status = 'approved'
      WHERE id = $2
    `, [userId, id]);

    console.log(`✅ Campaign approved: ${campaign.name} by user ${userId}`);

    res.json({
      success: true,
      message: 'Campaign approved successfully'
    });

  } catch (error) {
    console.error('Error approving campaign:', error);
    res.status(500).json({ error: 'Failed to approve campaign' });
  }
});

/**
 * Delete campaign
 * DELETE /api/campaigns/:id
 */
router.delete('/:id', authenticateToken, canCreateCampaigns, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Delete campaign (targets will cascade)
    const result = await pool.query(
      'DELETE FROM campaigns WHERE id = $1 AND created_by = $2 RETURNING *',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    console.log(`🗑️ Campaign deleted: ${result.rows[0].name}`);

    res.json({
      success: true,
      message: 'Campaign deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

module.exports = router;
