-- Digital Signage Database Schema
-- PostgreSQL 14+

-- Table: current_display
-- Stores the currently active display content (singleton table)
CREATE TABLE IF NOT EXISTS current_display (
  id INTEGER PRIMARY KEY DEFAULT 1,
  image_url VARCHAR(500) NOT NULL,
  displayed_at TIMESTAMP NOT NULL,
  duration INTEGER NOT NULL,
  clear_at TIMESTAMP NOT NULL,
  rotation INTEGER DEFAULT 0,
  mirror BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT single_row CHECK (id = 1)
);

-- Table: schedules
-- Stores all scheduled image displays
CREATE TABLE IF NOT EXISTS schedules (
  id SERIAL PRIMARY KEY,
  image_url VARCHAR(500) NOT NULL,
  scheduled_time TIMESTAMP NOT NULL,
  duration INTEGER NOT NULL DEFAULT 60000,
  repeat_type VARCHAR(20) DEFAULT 'once' CHECK (repeat_type IN ('once', 'daily', 'weekly', 'monthly', 'yearly')),
  rotation INTEGER DEFAULT 0 CHECK (rotation IN (0, 90, 180, 270)),
  mirror BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table: displays
-- Tracks connected displays
CREATE TABLE IF NOT EXISTS displays (
  id SERIAL PRIMARY KEY,
  socket_id VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(100) DEFAULT 'Display',
  status VARCHAR(20) DEFAULT 'online' CHECK (status IN ('online', 'offline')),
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table: upload_history
-- Tracks all image uploads for analytics
CREATE TABLE IF NOT EXISTS upload_history (
  id SERIAL PRIMARY KEY,
  image_url VARCHAR(500) NOT NULL,
  image_id VARCHAR(200),
  file_size INTEGER,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(45)
);

-- Table: display_history
-- Tracks what was displayed when
CREATE TABLE IF NOT EXISTS display_history (
  id SERIAL PRIMARY KEY,
  image_url VARCHAR(500) NOT NULL,
  displayed_at TIMESTAMP NOT NULL,
  duration INTEGER NOT NULL,
  rotation INTEGER DEFAULT 0,
  mirror BOOLEAN DEFAULT FALSE,
  schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL
);

-- Indexes for performance (PostgreSQL syntax)
CREATE INDEX IF NOT EXISTS idx_scheduled_time ON schedules(scheduled_time);
CREATE INDEX IF NOT EXISTS idx_status ON schedules(status);
CREATE INDEX IF NOT EXISTS idx_created_at ON schedules(created_at);

CREATE INDEX IF NOT EXISTS idx_socket_id ON displays(socket_id);
CREATE INDEX IF NOT EXISTS idx_display_status ON displays(status);

CREATE INDEX IF NOT EXISTS idx_uploaded_at ON upload_history(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_ip_address ON upload_history(ip_address);

CREATE INDEX IF NOT EXISTS idx_displayed_at ON display_history(displayed_at);
CREATE INDEX IF NOT EXISTS idx_schedule_id ON display_history(schedule_id);

-- Function: Update timestamp on row update
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = CURRENT_TIMESTAMP;
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: Auto-update updated_at on schedules
DROP TRIGGER IF EXISTS update_schedules_updated_at ON schedules;
CREATE TRIGGER update_schedules_updated_at
BEFORE UPDATE ON schedules
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE schedules IS 'Stores scheduled image displays with repeat options';
COMMENT ON TABLE displays IS 'Tracks connected display devices';
COMMENT ON TABLE upload_history IS 'Audit log of all image uploads';
COMMENT ON TABLE display_history IS 'Historical log of displayed content';

-- Sample queries for reference
-- Get pending schedules: SELECT * FROM schedules WHERE status = 'pending' AND scheduled_time <= NOW() ORDER BY scheduled_time;
-- Get active displays: SELECT * FROM displays WHERE status = 'online' AND last_seen > NOW() - INTERVAL '5 minutes';
-- Upload stats: SELECT COUNT(*), DATE(uploaded_at) FROM upload_history GROUP BY DATE(uploaded_at);
