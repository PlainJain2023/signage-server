/**
 * Display Selection Groups Module
 *
 * Manages groups for the "Select Device" screen navigation.
 * These are SEPARATE from device_groups (used in Settings/My Devices).
 *
 * Purpose: Organize devices for easier navigation when selecting
 * which device/group to display content on.
 */

const { pool } = require('./database');

// Get all selection groups for a user
async function getUserSelectionGroups(userId) {
  try {
    // First, ensure all groups have a display_order set
    await pool.query(`
      UPDATE display_selection_groups
      SET display_order = subquery.row_num
      FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY COALESCE(display_order, 999999), created_at DESC) - 1 as row_num
        FROM display_selection_groups
        WHERE user_id = $1 AND display_order IS NULL
      ) AS subquery
      WHERE display_selection_groups.id = subquery.id
    `, [userId]);

    const query = `
      SELECT
        dsg.id,
        dsg.group_name,
        dsg.created_at,
        dsg.updated_at,
        dsg.display_order,
        COUNT(dsgd.device_id) as device_count
      FROM display_selection_groups dsg
      LEFT JOIN display_selection_group_devices dsgd ON dsg.id = dsgd.group_id
      WHERE dsg.user_id = $1
      GROUP BY dsg.id, dsg.group_name, dsg.created_at, dsg.updated_at, dsg.display_order
      ORDER BY dsg.display_order ASC, dsg.created_at DESC
    `;

    const result = await pool.query(query, [userId]);
    return result.rows;
  } catch (error) {
    console.error('Error getting user selection groups:', error);
    throw error;
  }
}

// Get selection group with devices
async function getSelectionGroupWithDevices(groupId, userId) {
  try {
    // Get group info
    const groupQuery = `
      SELECT * FROM display_selection_groups
      WHERE id = $1 AND user_id = $2
    `;
    const groupResult = await pool.query(groupQuery, [groupId, userId]);

    if (groupResult.rows.length === 0) {
      throw new Error('Selection group not found');
    }

    const group = groupResult.rows[0];

    // Get devices in this group
    const devicesQuery = `
      SELECT
        d.id,
        d.device_name,
        d.serial_number,
        d.location,
        d.device_timezone,
        d.is_paired,
        d.paired_at,
        d.last_seen,
        d.status
      FROM displays d
      INNER JOIN display_selection_group_devices dsgd ON d.id = dsgd.device_id
      WHERE dsgd.group_id = $1 AND d.user_id = $2
      ORDER BY d.device_name ASC
    `;
    const devicesResult = await pool.query(devicesQuery, [groupId, userId]);

    return {
      group: {
        id: group.id,
        group_name: group.group_name,
        created_at: group.created_at,
        updated_at: group.updated_at
      },
      devices: devicesResult.rows
    };
  } catch (error) {
    console.error('Error getting selection group with devices:', error);
    throw error;
  }
}

// Create new selection group
async function createSelectionGroup(userId, groupName) {
  try {
    // Get the current max display_order for this user
    const maxOrderResult = await pool.query(
      'SELECT COALESCE(MAX(display_order), -1) as max_order FROM display_selection_groups WHERE user_id = $1',
      [userId]
    );
    const nextOrder = maxOrderResult.rows[0].max_order + 1;

    const query = `
      INSERT INTO display_selection_groups (user_id, group_name, display_order)
      VALUES ($1, $2, $3)
      RETURNING *
    `;

    const result = await pool.query(query, [userId, groupName, nextOrder]);
    return result.rows[0];
  } catch (error) {
    console.error('Error creating selection group:', error);
    throw error;
  }
}

// Update selection group name
async function updateSelectionGroup(groupId, userId, groupName) {
  try {
    const query = `
      UPDATE display_selection_groups
      SET group_name = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND user_id = $3
      RETURNING *
    `;

    const result = await pool.query(query, [groupName, groupId, userId]);

    if (result.rows.length === 0) {
      throw new Error('Selection group not found or unauthorized');
    }

    return result.rows[0];
  } catch (error) {
    console.error('Error updating selection group:', error);
    throw error;
  }
}

// Delete selection group
async function deleteSelectionGroup(groupId, userId) {
  try {
    const query = `
      DELETE FROM display_selection_groups
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `;

    const result = await pool.query(query, [groupId, userId]);

    if (result.rows.length === 0) {
      throw new Error('Selection group not found or unauthorized');
    }

    return result.rows[0];
  } catch (error) {
    console.error('Error deleting selection group:', error);
    throw error;
  }
}

// Add device to selection group
async function addDeviceToSelectionGroup(groupId, deviceId, userId) {
  try {
    // Verify group belongs to user
    const groupCheck = await pool.query(
      'SELECT id FROM display_selection_groups WHERE id = $1 AND user_id = $2',
      [groupId, userId]
    );

    if (groupCheck.rows.length === 0) {
      throw new Error('Selection group not found or unauthorized');
    }

    // Verify device belongs to user
    const deviceCheck = await pool.query(
      'SELECT id FROM displays WHERE id = $1 AND user_id = $2',
      [deviceId, userId]
    );

    if (deviceCheck.rows.length === 0) {
      throw new Error('Device not found or unauthorized');
    }

    // Add device to group (ignore if already exists)
    const query = `
      INSERT INTO display_selection_group_devices (group_id, device_id)
      VALUES ($1, $2)
      ON CONFLICT (group_id, device_id) DO NOTHING
      RETURNING *
    `;

    const result = await pool.query(query, [groupId, deviceId]);
    return result.rows[0] || { groupId, deviceId, alreadyExists: true };
  } catch (error) {
    console.error('Error adding device to selection group:', error);
    throw error;
  }
}

// Remove device from selection group
async function removeDeviceFromSelectionGroup(groupId, deviceId, userId) {
  try {
    // Verify group belongs to user
    const groupCheck = await pool.query(
      'SELECT id FROM display_selection_groups WHERE id = $1 AND user_id = $2',
      [groupId, userId]
    );

    if (groupCheck.rows.length === 0) {
      throw new Error('Selection group not found or unauthorized');
    }

    // Remove device from group
    const query = `
      DELETE FROM display_selection_group_devices
      WHERE group_id = $1 AND device_id = $2
      RETURNING *
    `;

    const result = await pool.query(query, [groupId, deviceId]);
    return result.rows[0];
  } catch (error) {
    console.error('Error removing device from selection group:', error);
    throw error;
  }
}

// Get all device IDs that are in any selection group for a user
async function getDeviceIdsInSelectionGroups(userId) {
  try {
    const query = `
      SELECT DISTINCT dsgd.device_id
      FROM display_selection_group_devices dsgd
      INNER JOIN display_selection_groups dsg ON dsgd.group_id = dsg.id
      WHERE dsg.user_id = $1
    `;

    const result = await pool.query(query, [userId]);
    return result.rows.map(row => row.device_id);
  } catch (error) {
    console.error('Error getting device IDs in selection groups:', error);
    throw error;
  }
}

module.exports = {
  getUserSelectionGroups,
  getSelectionGroupWithDevices,
  createSelectionGroup,
  updateSelectionGroup,
  deleteSelectionGroup,
  addDeviceToSelectionGroup,
  removeDeviceFromSelectionGroup,
  getDeviceIdsInSelectionGroups
};
