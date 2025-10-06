const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const rateLimit = require('express-rate-limit');
const { scheduleDb, uploadDb, displayDb, displayTrackingDb, currentDisplayDb, initializeDatabase } = require('./database');
const { registerUser, loginUser, refreshAccessToken, getUserById } = require('./auth');
const { authenticateToken, requireAdmin, optionalAuth } = require('./authMiddleware');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }
});

app.use(cors());
app.use(express.json());

// Rate limiting configuration
// Upload Rate Limiter: 50 uploads per minute, 500 per hour
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 50, // 50 requests per minute
  message: {
    error: 'Too many upload requests. Please wait a moment and try again.',
    retryAfter: 60
  },
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn('⚠️  Rate limit exceeded for upload from IP:', req.ip);
    res.status(429).json({
      error: 'Too many upload requests',
      message: 'Please wait a minute before uploading again',
      retryAfter: 60
    });
  }
});

// Hourly Upload Limiter: 500 uploads per hour
const hourlyUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: 500, // 500 requests per hour
  message: {
    error: 'Hourly upload limit reached. Please try again later.',
    retryAfter: 3600
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn('⚠️  Hourly rate limit exceeded for upload from IP:', req.ip);
    res.status(429).json({
      error: 'Hourly upload limit reached',
      message: 'You have exceeded the maximum uploads per hour. Please try again later.',
      retryAfter: 3600
    });
  }
});

// General API Rate Limiter: 100 requests per minute
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 100, // 100 requests per minute
  message: {
    error: 'Too many API requests. Please slow down.',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks and Socket.IO
    return req.path === '/health' || req.path.startsWith('/socket.io');
  }
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// In-memory tracking (for real-time features only)
let currentContent = null;

// Initialize database and load current content on startup
initializeDatabase()
  .then(async () => {
    // Load persisted current display from database
    const savedDisplay = await currentDisplayDb.get();
    if (savedDisplay) {
      const now = new Date();
      const clearAt = new Date(savedDisplay.clear_at);
      
      // Only restore if not expired
      if (clearAt > now) {
        currentContent = {
          type: 'image',
          url: savedDisplay.image_url,
          rotation: savedDisplay.rotation,
          mirror: savedDisplay.mirror,
          duration: savedDisplay.duration,
          displayedAt: new Date(savedDisplay.displayed_at),
          clearAt: clearAt
        };
        console.log('✅ Restored current display from database:', savedDisplay.image_url);
      } else {
        // Expired - clear from database
        await currentDisplayDb.clear();
        console.log('ℹ️  Previous display expired, cleared from database');
      }
    }
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

// ============================================
// AUTHENTICATION ROUTES
// ============================================

// Register new user
app.post('/api/auth/register', apiLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;

    // Validation
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Register user
    const result = await registerUser(email, password, name);

    console.log('✅ User registered:', email);
    res.status(201).json(result);
  } catch (error) {
    console.error('Registration failed:', error);
    if (error.message === 'User already exists') {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login user
app.post('/api/auth/login', apiLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await loginUser(email, password);

    console.log('✅ User logged in:', email);
    res.json(result);
  } catch (error) {
    console.error('Login failed:', error);
    res.status(401).json({ error: 'Invalid email or password' });
  }
});

// Refresh access token
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    const result = await refreshAccessToken(refreshToken);
    res.json(result);
  } catch (error) {
    console.error('Token refresh failed:', error);
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// Get current user info
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await getUserById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    console.error('Get user failed:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Logout (client-side handles token removal, this is just for logging)
app.post('/api/auth/logout', authenticateToken, (req, res) => {
  console.log('👋 User logged out:', req.user.email);
  res.json({ success: true, message: 'Logged out successfully' });
});

// ============================================
// EXISTING ROUTES
// ============================================

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('register-display', async (data) => {
    try {
      await displayTrackingDb.register(socket.id, data.name || 'Display');
      console.log('Display registered:', data.name);
      if (currentContent) {
        socket.emit('display-content', currentContent);
      }
    } catch (error) {
      console.error('Error registering display:', error);
    }
  });
  
  socket.on('disconnect', async () => {
    try {
      await displayTrackingDb.updateStatus(socket.id, 'offline');
      console.log('Display disconnected:', socket.id);
    } catch (error) {
      console.error('Error updating display status:', error);
    }
  });
});

app.post('/api/upload', uploadLimiter, hourlyUploadLimiter, upload.single('image'), async (req, res) => {
  try {
    // Check for password authentication
    const authPassword = req.headers['x-admin-password'];
    const isAuthenticated = authPassword === process.env.ADMIN_PASSWORD;
    
    // Log authentication status
    console.log('Upload attempt - Authenticated:', isAuthenticated);
    
    // ENFORCE: Block unauthenticated requests
    if (!isAuthenticated) {
      console.warn('⚠️  BLOCKED: Unauthenticated upload attempt');
      return res.status(401).json({ error: 'Unauthorized - Invalid or missing password' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: 'digital-signage' },
      async (error, result) => {
        if (error) {
          console.error('Cloudinary error:', error);
          return res.status(500).json({ error: 'Upload failed' });
        }
        
        // Save upload history to database
        try {
          await uploadDb.create({
            imageUrl: result.secure_url,
            imageId: result.public_id,
            fileSize: req.file.size,
            ipAddress: req.ip
          });
          console.log('✅ Upload logged to database');
        } catch (dbError) {
          console.error('⚠️  Failed to log upload to database:', dbError);
          // Don't fail the request if logging fails
        }
        
        res.json({
          success: true,
          image: {
            id: result.public_id,
            url: result.secure_url
          }
        });
      }
    );

    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/display-now', apiLimiter, async (req, res) => {
  const { imageUrl, rotation, mirror, duration } = req.body;
  console.log('Display Now request received:', { imageUrl, rotation, mirror, duration });
  
  if (!imageUrl) {
    return res.status(400).json({ error: 'Image URL required' });
  }
  const now = new Date();
  const displayDuration = duration || 60000; // Default 1 minute if not specified
  
  currentContent = {
    type: 'image',
    url: imageUrl,
    rotation: rotation || 0,
    mirror: mirror || false,
    duration: displayDuration,
    displayedAt: now,
    clearAt: new Date(now.getTime() + displayDuration)
  };
  
  // Save to current display database (persistent)
  try {
    await currentDisplayDb.set({
      imageUrl,
      displayedAt: now,
      duration: displayDuration,
      clearAt: currentContent.clearAt,
      rotation: rotation || 0,
      mirror: mirror || false
    });
    console.log('✅ Current display saved to database');
  } catch (error) {
    console.error('⚠️  Failed to save current display to database:', error);
  }
  
  // Save to display history
  try {
    await displayDb.create({
      imageUrl,
      displayedAt: now,
      duration: displayDuration,
      rotation: rotation || 0,
      mirror: mirror || false
    });
    console.log('✅ Display logged to history');
  } catch (error) {
    console.error('⚠️  Failed to log display:', error);
  }
  
  console.log('Content will clear at:', currentContent.clearAt);
  console.log('Sending to displays:', currentContent);
  io.emit('display-content', currentContent);
  res.json({ success: true });
});

app.post('/api/schedule', apiLimiter, async (req, res) => {
  const { imageUrl, scheduledTime, duration, repeat, rotation, mirror } = req.body;
  
  if (!imageUrl || !scheduledTime) {
    return res.status(400).json({ error: 'Image URL and scheduled time required' });
  }

  try {
    // Check for conflicts using database
    const hasConflict = await scheduleDb.hasConflict(scheduledTime, duration || 60000);
    if (hasConflict) {
      return res.status(409).json({ 
        error: 'Schedule conflict detected',
        message: 'Another image is already scheduled for this time period'
      });
    }

    // Create schedule in database
    const schedule = await scheduleDb.create({
      imageUrl,
      scheduledTime,
      duration: duration || 60000,
      repeat: repeat || 'once',
      rotation: rotation || 0,
      mirror: mirror || false
    });

    console.log('Schedule created:', schedule);
    res.json({ success: true, schedule });
  } catch (error) {
    console.error('Error creating schedule:', error);
    res.status(500).json({ error: 'Failed to create schedule' });
  }
});

app.get('/api/schedules', apiLimiter, async (req, res) => {
  try {
    const schedules = await scheduleDb.getAll();
    res.json({ schedules });
  } catch (error) {
    console.error('Error fetching schedules:', error);
    res.status(500).json({ error: 'Failed to fetch schedules' });
  }
});

app.put('/api/schedule/:id', apiLimiter, async (req, res) => {
  const { id } = req.params;
  const { scheduledTime, duration, repeat } = req.body;
  
  try {
    // Check for conflicts (excluding this schedule)
    if (scheduledTime || duration) {
      const hasConflict = await scheduleDb.hasConflict(
        scheduledTime,
        duration,
        id
      );
      if (hasConflict) {
        return res.status(409).json({ 
          error: 'Schedule conflict detected',
          message: 'Another image is already scheduled for this time period'
        });
      }
    }
    
    // Update schedule in database
    const schedule = await scheduleDb.update(id, {
      scheduledTime,
      duration,
      repeat
    });
    
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    
    console.log('Schedule updated:', schedule);
    res.json({ success: true, schedule });
  } catch (error) {
    console.error('Error updating schedule:', error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

app.delete('/api/schedule/:id', apiLimiter, async (req, res) => {
  const { id } = req.params;
  
  try {
    const deletedSchedule = await scheduleDb.delete(id);
    
    if (!deletedSchedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    
    console.log('Schedule deleted:', id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting schedule:', error);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Schedule checker - runs every 10 seconds
setInterval(async () => {
  const now = new Date();
  
  try {
    // Get pending schedules from database
    const pendingSchedules = await scheduleDb.getPending();
    
    for (const schedule of pendingSchedules) {
      currentContent = {
        type: 'image',
        url: schedule.image_url,
        duration: schedule.duration,
        rotation: schedule.rotation || 0,
        mirror: schedule.mirror || false,
        displayedAt: now,
        clearAt: new Date(now.getTime() + schedule.duration)
      };
      
      // Save to current display database (persistent)
      try {
        await currentDisplayDb.set({
          imageUrl: schedule.image_url,
          displayedAt: now,
          duration: schedule.duration,
          clearAt: currentContent.clearAt,
          rotation: schedule.rotation || 0,
          mirror: schedule.mirror || false
        });
      } catch (dbError) {
        console.error('⚠️  Failed to save scheduled display to database:', dbError);
      }
      
      io.emit('display-content', currentContent);
      
      // Log to display history
      try {
        await displayDb.create({
          imageUrl: schedule.image_url,
          displayedAt: now,
          duration: schedule.duration,
          rotation: schedule.rotation || 0,
          mirror: schedule.mirror || false,
          scheduleId: schedule.id
        });
      } catch (dbError) {
        console.error('⚠️  Failed to log scheduled display:', dbError);
      }
      
      // Handle repeat schedules
      if (schedule.repeat_type === 'once') {
        await scheduleDb.updateStatus(schedule.id, 'completed');
      } else {
        // Calculate next occurrence
        const currentTime = new Date(schedule.scheduled_time);
        let nextTime;
        
        switch (schedule.repeat_type) {
          case 'daily':
            nextTime = new Date(currentTime.getTime() + 24 * 60 * 60 * 1000);
            break;
          case 'weekly':
            nextTime = new Date(currentTime.getTime() + 7 * 24 * 60 * 60 * 1000);
            break;
          case 'monthly':
            nextTime = new Date(currentTime.getTime() + 30 * 24 * 60 * 60 * 1000);
            break;
          case 'yearly':
            nextTime = new Date(currentTime.getTime() + 365 * 24 * 60 * 60 * 1000);
            break;
        }
        
        if (nextTime) {
          await scheduleDb.reschedule(schedule.id, nextTime);
        }
      }
      
      console.log('Displayed scheduled content:', schedule.id);
    }
  } catch (error) {
    console.error('Error in schedule checker:', error);
  }
  
  // Check if current content duration has expired
  if (currentContent && currentContent.clearAt && now >= new Date(currentContent.clearAt)) {
    console.log('Content duration expired, clearing display');
    currentContent = null;
    io.emit('clear-content');
    
    // Clear from database
    try {
      await currentDisplayDb.clear();
      console.log('✅ Cleared expired content from database');
    } catch (error) {
      console.error('⚠️  Failed to clear expired content from database:', error);
    }
  }
}, 10000);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
