const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }
});

app.use(cors());
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

let displays = new Map();
let schedules = [];
let currentContent = null;

// Helper function to check for scheduling conflicts
const hasConflict = (newSchedule, existingSchedules, excludeId = null) => {
  const newStart = new Date(newSchedule.scheduledTime);
  const newEnd = new Date(newStart.getTime() + (newSchedule.duration || 60000));
  
  return existingSchedules.some(schedule => {
    // Skip the schedule being updated
    if (excludeId && schedule.id === excludeId) return false;
    
    // Only check pending schedules
    if (schedule.status !== 'pending') return false;
    
    const existingStart = new Date(schedule.scheduledTime);
    const existingEnd = new Date(existingStart.getTime() + (schedule.duration || 60000));
    
    // Check if time ranges overlap
    return (newStart < existingEnd && newEnd > existingStart);
  });
};

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('register-display', (data) => {
    displays.set(socket.id, {
      id: socket.id,
      name: data.name || 'Display',
      status: 'online'
    });
    console.log('Display registered:', data.name);
    if (currentContent) {
      socket.emit('display-content', currentContent);
    }
  });
  
  socket.on('disconnect', () => {
    if (displays.has(socket.id)) {
      console.log('Display disconnected');
      displays.delete(socket.id);
    }
  });
});

app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: 'digital-signage' },
      (error, result) => {
        if (error) {
          console.error('Cloudinary error:', error);
          return res.status(500).json({ error: 'Upload failed' });
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

app.post('/api/display-now', (req, res) => {
  const { imageUrl, rotation, mirror } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ error: 'Image URL required' });
  }
  currentContent = {
    type: 'image',
    url: imageUrl,
    rotation: rotation || 0,
    mirror: mirror || false,
    displayedAt: new Date()
  };
  console.log('Sending to displays:', currentContent);
  io.emit('display-content', currentContent);
  res.json({ success: true });
});

app.post('/api/schedule', (req, res) => {
  const { imageUrl, scheduledTime, duration, repeat, rotation, mirror } = req.body;
  
  if (!imageUrl || !scheduledTime) {
    return res.status(400).json({ error: 'Image URL and scheduled time required' });
  }

  const newSchedule = {
    imageUrl,
    scheduledTime: new Date(scheduledTime),
    duration: duration || 60000,
    repeat: repeat || 'once',
    rotation: rotation || 0,
    mirror: mirror || false
  };

  // Check for conflicts
  if (hasConflict(newSchedule, schedules)) {
    return res.status(409).json({ 
      error: 'Schedule conflict detected',
      message: 'Another image is already scheduled for this time period'
    });
  }

  const schedule = {
    id: Date.now().toString(),
    ...newSchedule,
    status: 'pending',
    createdAt: new Date()
  };

  schedules.push(schedule);
  console.log('Schedule created:', schedule);
  res.json({ success: true, schedule });
});

app.get('/api/schedules', (req, res) => {
  res.json({ schedules: schedules });
});

app.put('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  const { scheduledTime, duration, repeat } = req.body;
  
  const schedule = schedules.find(s => s.id === id);
  if (!schedule) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  
  // Create updated schedule for conflict checking
  const updatedSchedule = {
    ...schedule,
    scheduledTime: scheduledTime ? new Date(scheduledTime) : schedule.scheduledTime,
    duration: duration || schedule.duration,
    repeat: repeat || schedule.repeat
  };
  
  // Check for conflicts (excluding this schedule)
  if (hasConflict(updatedSchedule, schedules, id)) {
    return res.status(409).json({ 
      error: 'Schedule conflict detected',
      message: 'Another image is already scheduled for this time period'
    });
  }
  
  // Apply updates
  if (scheduledTime) schedule.scheduledTime = new Date(scheduledTime);
  if (duration) schedule.duration = duration;
  if (repeat) schedule.repeat = repeat;
  
  console.log('Schedule updated:', schedule);
  res.json({ success: true, schedule });
});

app.delete('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  const index = schedules.findIndex(s => s.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  
  schedules.splice(index, 1);
  console.log('Schedule deleted:', id);
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

setInterval(() => {
  const now = new Date();
  schedules.forEach(schedule => {
    if (schedule.status === 'pending' && schedule.scheduledTime <= now) {
      currentContent = {
        type: 'image',
        url: schedule.imageUrl,
        duration: schedule.duration,
        rotation: schedule.rotation || 0,
        mirror: schedule.mirror || false,
        displayedAt: now
      };
      io.emit('display-content', currentContent);
      
      if (schedule.repeat === 'once') {
        schedule.status = 'completed';
      } else if (schedule.repeat === 'daily') {
        schedule.scheduledTime = new Date(schedule.scheduledTime.getTime() + 24 * 60 * 60 * 1000);
      } else if (schedule.repeat === 'weekly') {
        schedule.scheduledTime = new Date(schedule.scheduledTime.getTime() + 7 * 24 * 60 * 60 * 1000);
      } else if (schedule.repeat === 'monthly') {
        schedule.scheduledTime = new Date(schedule.scheduledTime.getTime() + 30 * 24 * 60 * 60 * 1000);
      } else if (schedule.repeat === 'yearly') {
        schedule.scheduledTime = new Date(schedule.scheduledTime.getTime() + 365 * 24 * 60 * 60 * 1000);
      }
      console.log('Displayed scheduled content:', schedule.id);
    }
  });
}, 10000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
