const { pool } = require('./database');

// Create a new device group
async function createGroup(userId, groupName, color = '#667eea', icon = '📁') {
  try {
    const query = `
      INSERT INTO device_groups (user_id, group_name, color, icon)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const result = await pool.query(query, [userId, groupName, color, icon]);
    return result.rows[0];
  } catch (error) {
    console.error('Error creating group:', error);
    throw error;
  }
}

// Get all groups for a user
async function getUserGroups(userId) {
  try {
    const query = `
      SELECT
        g.*,
        COUNT(d.id) as device_count
      FROM device_groups g
      LEFT JOIN device_group_members gm ON g.id = gm.group_id
      LEFT JOIN displays d ON gm.device_id = d.id AND d.user_id = $1 AND d.is_paired = true
      WHERE g.user_id = $1
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `;
    const result = await pool.query(query, [userId]);
    return result.rows;
  } catch (error) {
    console.error('Error getting user groups:', error);
    throw error;
  }
}

// Get a specific group with its devices
async function getGroupWithDevices(groupId, userId) {
  try {
    // Get group info
    const groupQuery = `
      SELECT * FROM device_groups
      WHERE id = $1 AND user_id = $2
    `;
    const groupResult = await pool.query(groupQuery, [groupId, userId]);

    if (groupResult.rows.length === 0) {
      return null;
    }

    // Get devices in this group
    const devicesQuery = `
      SELECT
        d.*,
        gm.added_at
      FROM displays d
      JOIN device_group_members gm ON d.id = gm.device_id
      WHERE gm.group_id = $1
      ORDER BY d.device_name ASC
    `;
    const devicesResult = await pool.query(devicesQuery, [groupId]);

    return {
      ...groupResult.rows[0],
      devices: devicesResult.rows
    };
  } catch (error) {
    console.error('Error getting group with devices:', error);
    throw error;
  }
}

// Add devices to a group
async function addDevicesToGroup(groupId, deviceIds) {
  try {
    const values = deviceIds.map((deviceId, index) =>
      `($1, $${index + 2})`
    ).join(', ');

    const query = `
      INSERT INTO device_group_members (group_id, device_id)
      VALUES ${values}
      ON CONFLICT (group_id, device_id) DO NOTHING
      RETURNING *
    `;

    const result = await pool.query(query, [groupId, ...deviceIds]);
    return result.rows;
  } catch (error) {
    console.error('Error adding devices to group:', error);
    throw error;
  }
}

// Remove device from group
async function removeDeviceFromGroup(groupId, deviceId) {
  try {
    const query = `
      DELETE FROM device_group_members
      WHERE group_id = $1 AND device_id = $2
      RETURNING *
    `;
    const result = await pool.query(query, [groupId, deviceId]);
    return result.rows[0];
  } catch (error) {
    console.error('Error removing device from group:', error);
    throw error;
  }
}

// Update group info
async function updateGroup(groupId, userId, updates) {
  try {
    const { groupName, color, icon } = updates;

    const fields = [];
    const values = [];
    let paramCount = 1;

    if (groupName !== undefined) {
      fields.push(`group_name = $${paramCount++}`);
      values.push(groupName);
    }
    if (color !== undefined) {
      fields.push(`color = $${paramCount++}`);
      values.push(color);
    }
    if (icon !== undefined) {
      fields.push(`icon = $${paramCount++}`);
      values.push(icon);
    }

    fields.push(`updated_at = NOW()`);

    values.push(groupId, userId);

    const query = `
      UPDATE device_groups
      SET ${fields.join(', ')}
      WHERE id = $${paramCount++} AND user_id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, values);
    return result.rows[0];
  } catch (error) {
    console.error('Error updating group:', error);
    throw error;
  }
}

// Delete group
async function deleteGroup(groupId, userId) {
  try {
    const query = `
      DELETE FROM device_groups
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `;
    const result = await pool.query(query, [groupId, userId]);
    return result.rows[0];
  } catch (error) {
    console.error('Error deleting group:', error);
    throw error;
  }
}

// Get devices that belong to a group
async function getGroupDevices(groupId) {
  try {
    const query = `
      SELECT d.*
      FROM displays d
      JOIN device_group_members gm ON d.id = gm.device_id
      WHERE gm.group_id = $1
      ORDER BY d.device_name ASC
    `;
    const result = await pool.query(query, [groupId]);
    return result.rows;
  } catch (error) {
    console.error('Error getting group devices:', error);
    throw error;
  }
}

// Check which groups a device belongs to
async function getDeviceGroups(deviceId) {
  try {
    const query = `
      SELECT g.*
      FROM device_groups g
      JOIN device_group_members gm ON g.id = gm.group_id
      WHERE gm.device_id = $1
      ORDER BY g.group_name ASC
    `;
    const result = await pool.query(query, [deviceId]);
    return result.rows;
  } catch (error) {
    console.error('Error getting device groups:', error);
    throw error;
  }
}

module.exports = {
  createGroup,
  getUserGroups,
  getGroupWithDevices,
  addDevicesToGroup,
  removeDeviceFromGroup,
  updateGroup,
  deleteGroup,
  getGroupDevices,
  getDeviceGroups
};
