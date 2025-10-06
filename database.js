const { Pool } = require('pg');

// Database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20, // Maximum connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection on startup
pool.on('connect', () => {
  console.log('✅ Database connected successfully');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
  process.exit(-1);
});

// Schedule functions
const scheduleDb = {
  // Create a new schedule
  async create(scheduleData) {
    const { imageUrl, scheduledTime, duration, repeat, rotation, mirror } = scheduleData;
    const query = `
      INSERT INTO schedules (image_url, scheduled_time, duration, repeat_type, rotation, mirror, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      RETURNING *
    `;
    const values = [imageUrl, scheduledTime, duration || 60000, repeat || 'once', rotation || 0, mirror || false];
    const result = await pool.query(query, values);
    return result.rows[0];
  },

  // Get all schedules
  async getAll() {
    const query = 'SELECT * FROM schedules ORDER BY scheduled_time ASC';
    const result = await pool.query(query);
    return result.rows;
  },

  // Get pending schedules that should be displayed
  async getPending() {
    const query = `
      SELECT * FROM schedules 
      WHERE status = 'pending' AND scheduled_time <= NOW()
      ORDER BY scheduled_time ASC
    `;
    const result = await pool.query(query);
    return result.rows;
  },

  // Update schedule
  async update(id, updates) {
    const { scheduledTime, duration, repeat } = updates;
    const query = `
      UPDATE schedules 
      SET scheduled_time = COALESCE($1, scheduled_time),
          duration = COALESCE($2, duration),
          repeat_type = COALESCE($3, repeat_type)
      WHERE id = $4
      RETURNING *
    `;
    const values = [scheduledTime, duration, repeat, id];
    const result = await pool.query(query, values);
    return result.rows[0];
  },

  // Update schedule status
  async updateStatus(id, status) {
    const query = 'UPDATE schedules SET status = $1 WHERE id = $2 RETURNING *';
    const result = await pool.query(query, [status, id]);
    return result.rows[0];
  },

  // Reschedule for repeat
  async reschedule(id, newTime) {
    const query = 'UPDATE schedules SET scheduled_time = $1, status = $2 WHERE id = $3 RETURNING *';
    const result = await pool.query(query, [newTime, 'pending', id]);
    return result.rows[0];
  },

  // Delete schedule
  async delete(id) {
    const query = 'DELETE FROM schedules WHERE id = $1 RETURNING *';
    const result = await pool.query(query, [id]);
    return result.rows[0];
  },

  // Check for conflicts
  async hasConflict(scheduledTime, duration, excludeId = null) {
    const endTime = new Date(new Date(scheduledTime).getTime() + duration);
    const query = `
      SELECT * FROM schedules 
      WHERE status = 'pending'
        AND ($3::INTEGER IS NULL OR id != $3)
        AND (
          (scheduled_time <= $1 AND scheduled_time + (duration || ' milliseconds')::INTERVAL > $1)
          OR (scheduled_time < $2 AND scheduled_time + (duration || ' milliseconds')::INTERVAL >= $2)
          OR (scheduled_time >= $1 AND scheduled_time < $2)
        )
    `;
    const result = await pool.query(query, [scheduledTime, endTime, excludeId]);
    return result.rows.length > 0;
  }
};

// Upload history functions
const uploadDb = {
  async create(uploadData) {
    const { imageUrl, imageId, fileSize, ipAddress } = uploadData;
    const query = `
      INSERT INTO upload_history (image_url, image_id, file_size, ip_address)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const values = [imageUrl, imageId, fileSize, ipAddress];
    const result = await pool.query(query, values);
    return result.rows[0];
  },

  async getRecent(limit = 50) {
    const query = 'SELECT * FROM upload_history ORDER BY uploaded_at DESC LIMIT $1';
    const result = await pool.query(query, [limit]);
    return result.rows;
  }
};

// Display history functions
const displayDb = {
  async create(displayData) {
    const { imageUrl, displayedAt, duration, rotation, mirror, scheduleId } = displayData;
    const query = `
      INSERT INTO display_history (image_url, displayed_at, duration, rotation, mirror, schedule_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const values = [imageUrl, displayedAt, duration, rotation || 0, mirror || false, scheduleId || null];
    const result = await pool.query(query, values);
    return result.rows[0];
  },

  async getRecent(limit = 100) {
    const query = 'SELECT * FROM display_history ORDER BY displayed_at DESC LIMIT $1';
    const result = await pool.query(query, [limit]);
    return result.rows;
  }
};

// Display tracking functions
const displayTrackingDb = {
  async register(socketId, displayName) {
    const query = `
      INSERT INTO displays (socket_id, display_name, status, last_seen)
      VALUES ($1, $2, 'online', NOW())
      ON CONFLICT (socket_id) 
      DO UPDATE SET status = 'online', last_seen = NOW()
      RETURNING *
    `;
    const result = await pool.query(query, [socketId, displayName]);
    return result.rows[0];
  },

  async updateStatus(socketId, status) {
    const query = 'UPDATE displays SET status = $1, last_seen = NOW() WHERE socket_id = $2 RETURNING *';
    const result = await pool.query(query, [status, socketId]);
    return result.rows[0];
  },

  async getActive() {
    const query = `
      SELECT * FROM displays 
      WHERE status = 'online' AND last_seen > NOW() - INTERVAL '5 minutes'
    `;
    const result = await pool.query(query);
    return result.rows;
  }
};

// Current display functions
const currentDisplayDb = {
  // Set current display content (upsert)
  async set(displayData) {
    const { imageUrl, displayedAt, duration, clearAt, rotation, mirror } = displayData;
    const query = `
      INSERT INTO current_display (id, image_url, displayed_at, duration, clear_at, rotation, mirror)
      VALUES (1, $1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) 
      DO UPDATE SET 
        image_url = $1,
        displayed_at = $2,
        duration = $3,
        clear_at = $4,
        rotation = $5,
        mirror = $6,
        updated_at = NOW()
      RETURNING *
    `;
    const values = [imageUrl, displayedAt, duration, clearAt, rotation || 0, mirror || false];
    const result = await pool.query(query, values);
    return result.rows[0];
  },

  // Get current display content
  async get() {
    const query = 'SELECT * FROM current_display WHERE id = 1';
    const result = await pool.query(query);
    return result.rows[0] || null;
  },

  // Clear current display
  async clear() {
    const query = 'DELETE FROM current_display WHERE id = 1 RETURNING *';
    const result = await pool.query(query);
    return result.rows[0];
  },

  // Check if current display has expired
  async isExpired() {
    const query = 'SELECT clear_at FROM current_display WHERE id = 1';
    const result = await pool.query(query);
    if (result.rows.length === 0) return true;
    return new Date() >= new Date(result.rows[0].clear_at);
  }
};

// Initialize database tables
async function initializeDatabase() {
  const fs = require('fs');
  const path = require('path');
  
  try {
    console.log('🔄 Initializing database...');
    const schemaPath = path.join(__dirname, 'database-schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schema);
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

module.exports = {
  pool,
  scheduleDb,
  uploadDb,
  displayDb,
  displayTrackingDb,
  currentDisplayDb,
  initializeDatabase
};
