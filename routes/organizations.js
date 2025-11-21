/**
 * Organizations Routes (Enterprise Tier Feature)
 * Allows creating organizations with teams and hierarchical roles
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');
const { canAccessOrganizations } = require('../middleware/tierCheck');

// ═══════════════════════════════════════════════════════════
// ORGANIZATION ENDPOINTS
// ═══════════════════════════════════════════════════════════

/**
 * Create a new organization
 * POST /api/organizations
 * Requires: Enterprise tier
 */
router.post('/', authenticateToken, canAccessOrganizations, async (req, res) => {
  try {
    const { name, description, logoUrl } = req.body;
    const userId = req.user.userId;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Organization name is required' });
    }

    // Create organization
    const orgResult = await pool.query(`
      INSERT INTO organizations (
        org_name, owner_user_id, description, logo_url, subscription_tier
      ) VALUES ($1, $2, $3, $4, 'enterprise')
      RETURNING *
    `, [name.trim(), userId, description || null, logoUrl || null]);

    const org = orgResult.rows[0];

    // Add creator as admin member
    await pool.query(`
      INSERT INTO org_members (org_id, user_id, role)
      VALUES ($1, $2, 'admin')
    `, [org.id, userId]);

    console.log(`✅ Organization created: ${name} by user ${userId}`);

    res.json({
      success: true,
      organization: {
        id: org.id,
        name: org.org_name,
        description: org.description,
        logoUrl: org.logo_url,
        createdAt: org.created_at,
        role: 'admin'
      }
    });

  } catch (error) {
    console.error('Error creating organization:', error);
    res.status(500).json({ error: 'Failed to create organization' });
  }
});

/**
 * Get all organizations for current user
 * GET /api/organizations
 */
router.get('/', authenticateToken, canAccessOrganizations, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(`
      SELECT
        o.*,
        om.role,
        COUNT(DISTINCT om2.user_id) as member_count,
        COUNT(DISTINCT d.id) as device_count
      FROM organizations o
      JOIN org_members om ON o.id = om.org_id
      LEFT JOIN org_members om2 ON o.id = om2.org_id
      LEFT JOIN displays d ON o.id = d.org_id
      WHERE om.user_id = $1
      GROUP BY o.id, om.role
      ORDER BY o.created_at DESC
    `, [userId]);

    res.json({
      success: true,
      organizations: result.rows.map(org => ({
        id: org.id,
        name: org.org_name,
        description: org.description,
        logoUrl: org.logo_url,
        role: org.role,
        memberCount: parseInt(org.member_count) || 0,
        deviceCount: parseInt(org.device_count) || 0,
        createdAt: org.created_at
      }))
    });

  } catch (error) {
    console.error('Error fetching organizations:', error);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

/**
 * Get specific organization details
 * GET /api/organizations/:id
 */
router.get('/:id', authenticateToken, canAccessOrganizations, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Verify membership
    const memberResult = await pool.query(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const userRole = memberResult.rows[0].role;

    // Get organization
    const orgResult = await pool.query('SELECT * FROM organizations WHERE id = $1', [id]);

    if (orgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const org = orgResult.rows[0];

    // Get members
    const membersResult = await pool.query(`
      SELECT om.*, u.name, u.email
      FROM org_members om
      JOIN users u ON om.user_id = u.id
      WHERE om.org_id = $1
      ORDER BY
        CASE om.role
          WHEN 'admin' THEN 1
          WHEN 'manager' THEN 2
          WHEN 'member' THEN 3
        END,
        om.joined_at ASC
    `, [id]);

    // Get teams
    const teamsResult = await pool.query(
      'SELECT * FROM org_teams WHERE org_id = $1 ORDER BY created_at ASC',
      [id]
    );

    res.json({
      success: true,
      organization: {
        id: org.id,
        name: org.org_name,
        description: org.description,
        logoUrl: org.logo_url,
        subscriptionTier: org.subscription_tier,
        maxDevices: org.max_devices,
        maxMembers: org.max_members,
        createdAt: org.created_at,
        userRole,
        members: membersResult.rows.map(m => ({
          id: m.id,
          userId: m.user_id,
          name: m.name,
          email: m.email,
          role: m.role,
          joinedAt: m.joined_at
        })),
        teams: teamsResult.rows.map(t => ({
          id: t.id,
          name: t.team_name,
          description: t.description,
          createdAt: t.created_at
        }))
      }
    });

  } catch (error) {
    console.error('Error fetching organization:', error);
    res.status(500).json({ error: 'Failed to fetch organization' });
  }
});

/**
 * Update organization
 * PUT /api/organizations/:id
 * Requires: Admin or Manager role
 */
router.put('/:id', authenticateToken, canAccessOrganizations, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, logoUrl } = req.body;
    const userId = req.user.userId;

    // Verify admin/manager role
    const memberResult = await pool.query(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const role = memberResult.rows[0].role;
    if (role !== 'admin' && role !== 'manager') {
      return res.status(403).json({ error: 'Admin or Manager role required' });
    }

    // Update organization
    const result = await pool.query(`
      UPDATE organizations
      SET org_name = COALESCE($1, org_name),
          description = COALESCE($2, description),
          logo_url = COALESCE($3, logo_url)
      WHERE id = $4
      RETURNING *
    `, [name, description, logoUrl, id]);

    console.log(`✅ Organization updated: ${result.rows[0].org_name}`);

    res.json({
      success: true,
      organization: {
        id: result.rows[0].id,
        name: result.rows[0].org_name,
        description: result.rows[0].description,
        logoUrl: result.rows[0].logo_url
      }
    });

  } catch (error) {
    console.error('Error updating organization:', error);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

/**
 * Delete organization
 * DELETE /api/organizations/:id
 * Requires: Admin role (owner)
 */
router.delete('/:id', authenticateToken, canAccessOrganizations, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Verify ownership
    const orgResult = await pool.query(
      'SELECT * FROM organizations WHERE id = $1 AND owner_user_id = $2',
      [id, userId]
    );

    if (orgResult.rows.length === 0) {
      return res.status(403).json({ error: 'Only the owner can delete the organization' });
    }

    // Delete organization (members, teams will cascade)
    await pool.query('DELETE FROM organizations WHERE id = $1', [id]);

    console.log(`🗑️ Organization deleted: ${orgResult.rows[0].org_name}`);

    res.json({
      success: true,
      message: 'Organization deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting organization:', error);
    res.status(500).json({ error: 'Failed to delete organization' });
  }
});

/**
 * Add member to organization
 * POST /api/organizations/:id/members
 * Requires: Admin or Manager role
 */
router.post('/:id/members', authenticateToken, canAccessOrganizations, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, role = 'member' } = req.body;
    const userId = req.user.userId;

    // Validate role
    const validRoles = ['admin', 'manager', 'member'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Verify admin/manager role
    const memberResult = await pool.query(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const userRole = memberResult.rows[0].role;
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ error: 'Admin or Manager role required' });
    }

    // Find user by email
    const targetUserResult = await pool.query(
      'SELECT id, email, name FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (targetUserResult.rows.length === 0) {
      // Could create invitation here
      return res.status(404).json({ error: 'User not found with that email' });
    }

    const targetUser = targetUserResult.rows[0];

    // Check if already a member
    const existingMember = await pool.query(
      'SELECT * FROM org_members WHERE org_id = $1 AND user_id = $2',
      [id, targetUser.id]
    );

    if (existingMember.rows.length > 0) {
      return res.status(409).json({ error: 'User is already a member' });
    }

    // Add member
    const result = await pool.query(`
      INSERT INTO org_members (org_id, user_id, role)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [id, targetUser.id, role]);

    console.log(`✅ Member added to org ${id}: ${targetUser.email} (${role})`);

    res.json({
      success: true,
      member: {
        id: result.rows[0].id,
        userId: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
        role: result.rows[0].role,
        joinedAt: result.rows[0].joined_at
      }
    });

  } catch (error) {
    console.error('Error adding member:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

/**
 * Update member role
 * PUT /api/organizations/:id/members/:memberId
 * Requires: Admin role
 */
router.put('/:id/members/:memberId', authenticateToken, canAccessOrganizations, async (req, res) => {
  try {
    const { id, memberId } = req.params;
    const { role } = req.body;
    const userId = req.user.userId;

    // Validate role
    const validRoles = ['admin', 'manager', 'member'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Verify admin role
    const memberResult = await pool.query(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (memberResult.rows.length === 0 || memberResult.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }

    // Update member role
    const result = await pool.query(`
      UPDATE org_members
      SET role = $1
      WHERE id = $2 AND org_id = $3
      RETURNING *
    `, [role, memberId, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    console.log(`✅ Member role updated in org ${id}: ${role}`);

    res.json({
      success: true,
      message: 'Member role updated',
      member: {
        id: result.rows[0].id,
        role: result.rows[0].role
      }
    });

  } catch (error) {
    console.error('Error updating member role:', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
});

/**
 * Remove member from organization
 * DELETE /api/organizations/:id/members/:memberId
 * Requires: Admin or Manager role
 */
router.delete('/:id/members/:memberId', authenticateToken, canAccessOrganizations, async (req, res) => {
  try {
    const { id, memberId } = req.params;
    const userId = req.user.userId;

    // Verify admin/manager role
    const memberResult = await pool.query(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const userRole = memberResult.rows[0].role;
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ error: 'Admin or Manager role required' });
    }

    // Prevent removing owner
    const orgResult = await pool.query('SELECT owner_user_id FROM organizations WHERE id = $1', [id]);
    const targetMemberResult = await pool.query('SELECT user_id FROM org_members WHERE id = $1', [memberId]);

    if (targetMemberResult.rows.length > 0 &&
        targetMemberResult.rows[0].user_id === orgResult.rows[0].owner_user_id) {
      return res.status(403).json({ error: 'Cannot remove the organization owner' });
    }

    // Remove member
    const result = await pool.query(
      'DELETE FROM org_members WHERE id = $1 AND org_id = $2 RETURNING *',
      [memberId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    console.log(`🗑️ Member removed from org ${id}`);

    res.json({
      success: true,
      message: 'Member removed successfully'
    });

  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = router;
