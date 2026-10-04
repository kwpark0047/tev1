require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  }
});

// PostgreSQL connection pool with optimized settings
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/tev1',
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  maxUses: 7500,
});

// Redis connection with retry strategy
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => {
    if (times > 3) return null; // Stop retrying
    return Math.min(times * 200, 2000);
  },
  lazyConnect: true,
});

// Track DB/Redis availability
let dbAvailable = false;
let redisAvailable = false;

// Health check for PostgreSQL
async function checkDatabaseHealth() {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    dbAvailable = true;
    return true;
  } catch (e) {
    dbAvailable = false;
    return false;
  }
}

// Health check for Redis
async function checkRedisHealth() {
  try {
    if (!redisAvailable) {
      await redis.connect();
    }
    await redis.ping();
    redisAvailable = true;
    return true;
  } catch (e) {
    redisAvailable = false;
    return false;
  }
}

// Graceful query wrapper with fallback
async function queryWithFallback(query, params, fallback = null) {
  if (!dbAvailable) {
    const isHealthy = await checkDatabaseHealth();
    if (!isHealthy) {
      console.warn('Database unavailable, using fallback');
      return fallback;
    }
  }
  try {
    const result = await pool.query(query, params);
    return result;
  } catch (e) {
    console.error('Query error:', e);
    dbAvailable = false;
    return fallback;
  }
}

// Cache wrapper for Redis
async function getCached(key, fallbackFn, ttl = 300) {
  if (!redisAvailable) return await fallbackFn();
  
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
    
    const fresh = await fallbackFn();
    await redis.setex(key, ttl, JSON.stringify(fresh));
    return fresh;
  } catch (e) {
    console.warn('Redis cache error, using direct query:', e);
    return await fallbackFn();
  }
}

async function invalidateCache(key) {
  if (!redisAvailable) return;
  try {
    await redis.del(key);
  } catch (e) {
    console.warn('Cache invalidation error:', e);
  }
}

// Batch query for better performance
async function batchQuery(queries) {
  if (!dbAvailable) return queries.map(() => null);
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const { query, params } of queries) {
      const result = await client.query(query, params);
      results.push(result);
    }
    await client.query('COMMIT');
    return results;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Optimized user lookup with cache
async function getUserWithCache(userId) {
  return await getCached(
    `user:${userId}`,
    async () => {
      const result = await pool.query(
        'SELECT id, name, color FROM users WHERE id = $1',
        [userId]
      );
      return result.rows[0] || null;
    },
    600 // 10분 캐시
  );
}

// Optimized room lookup with cache
async function getRoomWithCache(roomId) {
  return await getCached(
    `room:${roomId}`,
    async () => {
      const result = await pool.query(
        'SELECT id, name, created_at FROM rooms WHERE id = $1',
        [roomId]
      );
      return result.rows[0] || null;
    },
    300 // 5분 캐시
  );
}

// Invalidate user/room cache on updates
async function invalidateUserCache(userId) {
  await invalidateCache(`user:${userId}`);
  // Also invalidate related room caches
  const rooms = await pool.query('SELECT room_id FROM room_users WHERE user_id = $1', [userId]);
  for (const r of rooms.rows) {
    await invalidateCache(`room:${r.room_id}`);
  }
}

async function invalidateRoomCache(roomId) {
  await invalidateCache(`room:${roomId}`);
}

// Setup database with error handling
async function setupDatabase() {
  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          color VARCHAR(7) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS rooms (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS room_users (
          room_id VARCHAR(255) REFERENCES rooms(id),
          user_id VARCHAR(255) REFERENCES users(id),
          joined_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (room_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          room_id VARCHAR(255) REFERENCES rooms(id),
          user_id VARCHAR(255) REFERENCES users(id),
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS cursors (
          id SERIAL PRIMARY KEY,
          room_id VARCHAR(255) REFERENCES rooms(id),
          user_id VARCHAR(255) REFERENCES users(id),
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS user_tokens (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) REFERENCES users(id),
          provider VARCHAR(50) NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expiry BIGINT,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, provider)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cursors_room_user ON cursors(room_id, user_id);

        -- 조직(Organization) 테이블
        CREATE TABLE IF NOT EXISTS organizations (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          slug VARCHAR(100) UNIQUE NOT NULL,
          description TEXT,
          logo_url TEXT,
          settings JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        -- 조직 멤버십 (사용자-조직 연결)
        CREATE TABLE IF NOT EXISTS organization_members (
          id SERIAL PRIMARY KEY,
          organization_id VARCHAR(255) REFERENCES organizations(id) ON DELETE CASCADE,
          user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
          role VARCHAR(50) NOT NULL DEFAULT 'member', -- owner, admin, member, viewer
          joined_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(organization_id, user_id)
        );

        -- 역할(Role) 정의
        CREATE TABLE IF NOT EXISTS roles (
          id VARCHAR(50) PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          permissions JSONB NOT NULL DEFAULT '[]', -- 권한 목록
          is_system BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW()
        );

        -- 방-조직 연결 (조직 내 방)
        CREATE TABLE IF NOT EXISTS room_organizations (
          room_id VARCHAR(255) REFERENCES rooms(id) ON DELETE CASCADE,
          organization_id VARCHAR(255) REFERENCES organizations(id) ON DELETE CASCADE,
          PRIMARY KEY (room_id, organization_id)
        );

        -- 조직 초대 토큰
        CREATE TABLE IF NOT EXISTS organization_invites (
          id SERIAL PRIMARY KEY,
          organization_id VARCHAR(255) REFERENCES organizations(id) ON DELETE CASCADE,
          email VARCHAR(255),
          role VARCHAR(50) NOT NULL DEFAULT 'member',
          token VARCHAR(255) UNIQUE NOT NULL,
          invited_by VARCHAR(255) REFERENCES users(id),
          expires_at TIMESTAMP NOT NULL,
          accepted_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        );

        -- 감사 로그 (보안/컴플라이언스용)
        CREATE TABLE IF NOT EXISTS audit_logs (
          id SERIAL PRIMARY KEY,
          organization_id VARCHAR(255) REFERENCES organizations(id) ON DELETE SET NULL,
          user_id VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
          action VARCHAR(100) NOT NULL,
          resource_type VARCHAR(50),
          resource_id VARCHAR(255),
          metadata JSONB DEFAULT '{}',
          ip_address INET,
          user_agent TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(organization_id);
        CREATE INDEX IF NOT EXISTS idx_room_orgs_room ON room_organizations(room_id);
        CREATE INDEX IF NOT EXISTS idx_room_orgs_org ON room_organizations(organization_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(organization_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_invites_token ON organization_invites(token);
        CREATE INDEX IF NOT EXISTS idx_invites_email ON organization_invites(email);
      `);
      console.log('Database tables created/verified');
      dbAvailable = true;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Database setup failed, running in memory-only mode:', e.message);
    dbAvailable = false;
  }
  
  // Try Redis connection
  try {
    await redis.connect();
    redisAvailable = true;
    console.log('Redis connected');
  } catch (e) {
    console.warn('Redis unavailable, running without cache:', e.message);
    redisAvailable = false;
  }
}

// Socket.IO Redis adapter for scaling
(async () => {
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
})();

// In-memory storage (fallback)
const rooms = new Map(); // roomId -> { users: Map, cursors: Map }
const userConnections = new Map(); // ws -> { userId, roomId, name, color }

const JWT_SECRET = process.env.JWT_SECRET || 'tev1-secret-key-change-in-production';

// Generate random color for user
function getRandomColor() {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFBE0B', '#FB5607',
    '#8338EC', '#3A86FF', '#06D6A0', '#FF006E', '#FB8500'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Generate JWT token
function generateToken(userId, name) {
  return jwt.sign({ userId, name, iat: Date.now() }, JWT_SECRET, { expiresIn: '24h' });
}

// Verify JWT token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Broadcast to room via Socket.IO
function broadcastToRoomViaIO(roomId, message) {
  io.to(`room-${roomId}`).emit('message', message);
}

// Broadcast to all via Socket.IO
function broadcastToAllViaIO(message) {
  io.emit('message', message);
}

// Store message in DB
async function storeMessage(roomId, userId, content) {
  try {
    await pool.query(
      'INSERT INTO messages (room_id, user_id, content) VALUES ($1, $2, $3)',
      [roomId, userId, content]
    );
    // Broadcast to room via Socket.IO
    broadcastToRoomViaIO(roomId, {
      type: 'message',
      roomId,
      userId,
      content,
      timestamp: Date.now()
    });
  } catch (e) {
    console.error('Error storing message:', e);
  }
}

// Handle new connection
io.on('connection', (socket) => {
  console.log('Socket.IO connection:', socket.id);

  socket.on('auth', async (data) => {
    try {
      const decoded = verifyToken(data.token);
      if (decoded) {
        socket.userId = decoded.userId;
        socket.userName = decoded.name;
        socket.roomId = data.roomId;

        // Check if user exists, if not create
        const userExists = await pool.query(
          'SELECT id FROM users WHERE id = $1',
          [decoded.userId]
        );

        if (userExists.rows.length === 0) {
          const color = getRandomColor();
          await pool.query(
            'INSERT INTO users (id, name, color) VALUES ($1, $2, $3)',
            [decoded.userId, decoded.name, color]
          );
        }

        // Join room
        socket.join(`room-${data.roomId}`);

        // Add to in-memory rooms
        if (!rooms.has(data.roomId)) {
          rooms.set(data.roomId, { users: new Map(), cursors: new Map() });
        }
        const room = rooms.get(data.roomId);
        const color = color || getRandomColor();
        room.users.set(socket.userId, { id: decoded.userId, name: decoded.name, color });

        // Notify user joined
        socket.emit('joined', {
          id: decoded.userId,
          name: decoded.name,
          color,
          users: Array.from(room.users.values()).map(u => ({ id: u.id, name: u.name, color: u.color }))
        });

        // Notify others
        socket.to(`room-${data.roomId}`).emit('user_joined', {
          userId: decoded.userId,
          name: decoded.name,
          color,
          users: Array.from(room.users.values()).map(u => ({ id: u.id, name: u.name, color: u.color }))
        });

        // Get existing cursors from DB
        const cursors = await pool.query(
          'SELECT user_id, x, y FROM cursors WHERE room_id = $1',
          [data.roomId]
        );
        cursors.rows.forEach(cursor => {
          room.cursors.set(cursor.user_id, { x: cursor.x, y: cursor.y });
        });

        // Broadcast existing cursors
        io.to(`room-${data.roomId}`).emit('cursor_broadcast', {
          cursors: Array.from(room.cursors.entries()).map(([uid, pos]) => ({
            userId: uid,
            x: pos.x,
            y: pos.y
          }))
        });

        console.log(`User ${decoded.name} (${decoded.userId}) joined room ${data.roomId}`);
      } else {
        socket.emit('auth_error', { message: 'Invalid token' });
        socket.disconnect();
      }
    } catch (e) {
      console.error('Auth error:', e);
      socket.emit('auth_error', { message: 'Auth failed' });
      socket.disconnect();
    }
  });

  socket.on('cursor', (data) => {
    if (!socket.roomId) return;

    const room = rooms.get(socket.roomId);
    if (!room) return;

    // Update cursor in room
    room.cursors.set(socket.userId, { x: data.x, y: data.y });

    // Update in DB
    pool.query(
      'INSERT INTO cursors (room_id, user_id, x, y, updated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (room_id, user_id) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, updated_at = NOW()',
      [socket.roomId, socket.userId, data.x, data.y]
    );

    // Broadcast cursor to others in room
    socket.to(`room-${socket.roomId}`).emit('cursor', {
      userId: socket.userId,
      x: data.x,
      y: data.y,
      name: room.users.get(socket.userId)?.name || 'Unknown',
      color: room.users.get(socket.userId)?.color || '#FFFFFF'
    });
  });

  socket.on('message', async (data) => {
    if (!socket.roomId || !socket.userId) return;

    const content = data.content || '';
    if (!content) return;

    // Store message in DB
    await storeMessage(socket.roomId, socket.userId, content);

    // Broadcast to room via Socket.IO
    io.to(`room-${socket.roomId}`).emit('message', {
      type: 'message',
      roomId: socket.roomId,
      userId: socket.userId,
      name: socket.userName || 'Unknown',
      content,
      timestamp: Date.now()
    });
  });

  socket.on('leave', () => {
    if (socket.roomId) {
      socket.leave(`room-${socket.roomId}`);

      // Remove from in-memory rooms
      if (rooms.has(socket.roomId)) {
        const room = rooms.get(socket.roomId);
        room.users.delete(socket.userId);
        room.cursors.delete(socket.userId);

        // Notify others
        socket.to(`room-${socket.roomId}`).emit('user_left', {
          userId: socket.userId,
          name: socket.userName || 'Unknown'
        });

        // Clean up empty room
        if (room.users.size === 0) {
          rooms.delete(socket.roomId);
        }
      }

      socket.roomId = null;
      socket.userId = null;
      socket.userName = null;
    }
  });

  socket.on('disconnect', async () => {
    console.log('Socket.IO disconnect:', socket.id);
    if (socket.userId && socket.roomId) {
      // Update status in DB
      await pool.query(
        'UPDATE users SET status = \'disconnected\' WHERE id = $1',
        [socket.userId]
      );

      // Remove from in-memory rooms
      if (rooms.has(socket.roomId)) {
        const room = rooms.get(socket.roomId);
        if (room) {
          room.users.delete(socket.userId);
          room.cursors.delete(socket.userId);

          // Notify others
          socket.to(`room-${socket.roomId}`).emit('user_left', {
            userId: socket.userId,
            name: socket.userName || 'Unknown'
          });

          // Clean up empty room
          if (room.users.size === 0) {
            rooms.delete(socket.roomId);
          }
        }
      }

      socket.roomId = null;
      socket.userId = null;
      socket.userName = null;
    }
  });
});

// REST API endpoints
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: Date.now(), 
    connections: wss.clients.size, 
    socketio: io.engine.clientsCount,
    database: dbAvailable ? 'connected' : 'disconnected',
    redis: redisAvailable ? 'connected' : 'disconnected'
  });
});

// 상세 헬스체크 (모니터링용)
app.get('/health/detailed', async (req, res) => {
  const dbHealthy = await checkDatabaseHealth();
  const redisHealthy = await checkRedisHealth();
  
  const dbStats = dbHealthy ? await pool.query('SELECT count(*) as user_count FROM users').then(r => r.rows[0]) : null;
  const redisStats = redisHealthy ? await redis.info('memory').then(r => r) : null;
  
  res.json({
    status: dbHealthy && redisHealthy ? 'healthy' : 'degraded',
    timestamp: Date.now(),
    services: {
      database: { status: dbHealthy ? 'up' : 'down', stats: dbStats },
      redis: { status: redisHealthy ? 'up' : 'down', stats: redisStats },
      websocket: { connections: wss.clients.size },
      socketio: { connections: io.engine.clientsCount }
    },
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount
    }
  });
});

// 데이터베이스 상태 강제 재확인
app.post('/health/recheck', async (req, res) => {
  const dbHealthy = await checkDatabaseHealth();
  const redisHealthy = await checkRedisHealth();
  res.json({ database: dbHealthy, redis: redisHealthy });
});

app.post('/api/auth/token', (req, res) => {
  const { userId, name } = req.body;
  if (!userId || !name) {
    return res.status(400).json({ error: 'userId and name required' });
  }
  const token = generateToken(userId, name);
  res.json({ token });
});

app.post('/api/auth/login', async (req, res) => {
  const { userId, name } = req.body;
  if (!userId || !name) {
    return res.status(400).json({ error: 'userId and name required' });
  }
  try {
    // 사용자 존재 확인 (있으면 토큰 재발급, 없으면 신규 생성)
    const userExists = await pool.query(
      'SELECT id, name, color FROM users WHERE id = $1',
      [userId]
    );

    if (userExists.rows.length === 0) {
      // 신규 사용자 생성 (기본 색상 할당)
      const color = getRandomColor();
      await pool.query(
        'INSERT INTO users (id, name, color) VALUES ($1, $2, $3)',
        [userId, name, color]
      );
    }

    // JWT 토큰 생성
    const token = generateToken(userId, name);
    res.json({ token, userId, name });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Invalid token' });

    const user = await pool.query(
      'SELECT id, name, color FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    res.json({ user: user.rows[0] });
  } catch (e) {
    res.status(401).json({ error: 'Token verification failed' });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, created_at FROM rooms ORDER BY created_at DESC');
    res.json({ rooms: result.rows });
  } catch (e) {
    console.error('Error fetching rooms:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/rooms/:roomId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT u.id, u.name, u.color, ru.joined_at FROM room_users ru JOIN users u ON ru.user_id = u.id WHERE ru.room_id = $1',
      [req.params.roomId]
    );
    res.json({ users: result.rows });
  } catch (e) {
    console.error('Error fetching room users:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// Google Calendar Integration
const { google } = require('googleapis');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8081/api/auth/google/callback';

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Google OAuth2 URL 생성
app.get('/api/auth/google/url', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events'
  ];
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    state: JSON.stringify({ userId: req.query.userId || 'anonymous' })
  });
  res.json({ url });
});

// Google OAuth2 콜백 처리
app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Authorization code missing');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // 상태 복원 및 사용자 연결
    const stateData = JSON.parse(state || '{}');
    const userId = stateData.userId;

    // 토큰 DB에 저장 (실제 구현 시 암호화 필요)
    if (userId) {
      await pool.query(
        'INSERT INTO user_tokens (user_id, provider, access_token, refresh_token, expiry) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, provider) DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, expiry = EXCLUDED.expiry',
        [userId, 'google', tokens.access_token, tokens.refresh_token, tokens.expiry_date]
      );
    }

    // 프론트엔드로 리다이렉트 (토큰 전달)
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:8082'}?google_auth=success&tokens=${encodeURIComponent(JSON.stringify(tokens))}`);
  } catch (e) {
    console.error('Google OAuth callback error:', e);
    res.status(500).send('Authentication failed');
  }
});

// 캘린더 이벤트 생성 (회의에서 캘린더 등록)
app.post('/api/calendar/events', async (req, res) => {
  try {
    const { userId, title, description, startTime, endTime, attendees, location } = req.body;
    if (!userId || !title || !startTime || !endTime) {
      return res.status(400).json({ error: 'Required fields missing' });
    }

    // 사용자 토큰 조회
    const tokenResult = await pool.query(
      'SELECT access_token, refresh_token, expiry FROM user_tokens WHERE user_id = $1 AND provider = $2',
      [userId, 'google']
    );

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({ error: 'Google Calendar not connected', authUrl: '/api/auth/google/url' });
    }

    const tokens = tokenResult.rows[0];
    oauth2Client.setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // 이벤트 생성
    const event = {
      summary: title,
      description: description || '',
      start: { dateTime: startTime, timeZone: 'Asia/Seoul' },
      end: { dateTime: endTime, timeZone: 'Asia/Seoul' },
      attendees: attendees?.map(email => ({ email })) || [],
      location: location || '',
      reminders: { useDefault: true }
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
      sendUpdates: 'all'
    });

    res.json({ success: true, event: response.data });
  } catch (e) {
    console.error('Calendar event creation error:', e);
    res.status(500).json({ error: 'Failed to create calendar event' });
  }
});

// 캘린더 이벤트 목록 조회
app.get('/api/calendar/events', async (req, res) => {
  try {
    const { userId, timeMin, timeMax } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const tokenResult = await pool.query(
      'SELECT access_token, refresh_token, expiry FROM user_tokens WHERE user_id = $1 AND provider = $2',
      [userId, 'google']
    );

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({ error: 'Google Calendar not connected' });
    }

    const tokens = tokenResult.rows[0];
    oauth2Client.setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin || new Date().toISOString(),
      timeMax: timeMax,
      maxResults: 50,
      singleEvents: true,
      orderBy: 'startTime'
    });

    res.json({ events: response.data.items || [] });
  } catch (e) {
    console.error('Calendar events fetch error:', e);
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// 회의에서 캘린더 등록 (자동화용)
app.post('/api/meetings/:meetingId/calendar', async (req, res) => {
  try {
    const { meetingId } = req.params;
    const { userId, autoAdd } = req.body;

    // 회의 정보 조회 (room_users 또는 messages 테이블에서)
    const meetingResult = await pool.query(`
      SELECT 
        r.id as room_id,
        r.name as room_name,
        u.name as creator_name,
        m.content,
        m.created_at
      FROM rooms r
      JOIN room_users ru ON r.id = ru.room_id
      JOIN users u ON ru.user_id = u.id
      LEFT JOIN messages m ON m.room_id = r.id
      WHERE r.id = $1
      ORDER BY m.created_at ASC
      LIMIT 1
    `, [meetingId]);

    if (meetingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    const meeting = meetingResult.rows[0];
    const startTime = new Date(meeting.created_at);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 기본 1시간

    // 캘린더 이벤트 자동 생성
    if (autoAdd && userId) {
      const tokenResult = await pool.query(
        'SELECT access_token, refresh_token, expiry FROM user_tokens WHERE user_id = $1 AND provider = $2',
        [userId, 'google']
      );

      if (tokenResult.rows.length > 0) {
        const tokens = tokenResult.rows[0];
        oauth2Client.setCredentials(tokens);

        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        const event = {
          summary: meeting.room_name || `회의: ${meetingId}`,
          description: meeting.content || '',
          start: { dateTime: startTime.toISOString(), timeZone: 'Asia/Seoul' },
          end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Seoul' }
        };

        const response = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: event,
          sendUpdates: 'all'
        });

        return res.json({ success: true, event: response.data, autoAdded: true });
      }
    }

    res.json({ 
      meeting: { id: meetingId, title: meeting.room_name, start: startTime, end: endTime },
      requiresAuth: !autoAdd || !userId
    });
  } catch (e) {
    console.error('Meeting to calendar error:', e);
    res.status(500).json({ error: 'Failed to process meeting calendar' });
  }
});

// ============================================
// 조직(Organization) 관리 API
// ============================================

// 조직 생성
app.post('/api/organizations', async (req, res) => {
  try {
    const { userId, name, slug, description } = req.body;
    if (!userId || !name || !slug) {
      return res.status(400).json({ error: 'userId, name, slug required' });
    }

    // 슬러그 중복 확인
    const existing = await pool.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Slug already exists' });
    }

    // 조직 생성 + 소유자 추가 (트랜잭션)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const orgResult = await client.query(
        'INSERT INTO organizations (id, name, slug, description) VALUES ($1, $2, $3, $4) RETURNING *',
        [require('uuid').v4(), name, slug, description || '']
      );
      const org = orgResult.rows[0];

      // 소유자 멤버십 추가
      await client.query(
        'INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)',
        [org.id, userId, 'owner']
      );

      // 감사 로그
      await client.query(
        'INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4, $5)',
        [org.id, userId, 'create', 'organization', org.id]
      );

      await client.query('COMMIT');
      res.json({ organization: org });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Create organization error:', e);
    res.status(500).json({ error: 'Failed to create organization' });
  }
});

// 조직 목록 조회 (사용자 소속)
app.get('/api/organizations', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const result = await pool.query(`
      SELECT o.*, om.role, om.joined_at
      FROM organizations o
      JOIN organization_members om ON o.id = om.organization_id
      WHERE om.user_id = $1
      ORDER BY o.created_at DESC
    `, [userId]);

    res.json({ organizations: result.rows });
  } catch (e) {
    console.error('Fetch organizations error:', e);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

// 조직 상세 조회
app.get('/api/organizations/:orgId', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { userId } = req.query;

    const orgResult = await pool.query('SELECT * FROM organizations WHERE id = $1', [orgId]);
    if (orgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const org = orgResult.rows[0];

    // 멤버 조회
    const membersResult = await pool.query(`
      SELECT om.*, u.name, u.color
      FROM organization_members om
      JOIN users u ON om.user_id = u.id
      WHERE om.organization_id = $1
      ORDER BY 
        CASE om.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'member' THEN 3 WHEN 'viewer' THEN 4 ELSE 5 END,
        om.joined_at
    `, [orgId]);

    // 방 목록
    const roomsResult = await pool.query(`
      SELECT r.*
      FROM rooms r
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE ro.organization_id = $1
      ORDER BY r.created_at DESC
    `, [orgId]);

    // 권한 확인 (멤버인지)
    let userRole = null;
    if (userId) {
      const roleResult = await pool.query(
        'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
        [orgId, userId]
      );
      userRole = roleResult.rows[0]?.role;
    }

    res.json({ organization: org, members: membersResult.rows, rooms: roomsResult.rows, userRole });
  } catch (e) {
    console.error('Fetch organization error:', e);
    res.status(500).json({ error: 'Failed to fetch organization' });
  }
});

// 조직 업데이트 (owner/admin만)
app.patch('/api/organizations/:orgId', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { userId, name, description, settings } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // 권한 확인
    const roleResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    const userRole = roleResult.rows[0]?.role;
    if (!userRole || !['owner', 'admin'].includes(userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const updates = [];
    const params = [];
    let paramIdx = 1;

    if (name) { updates.push(`name = $${paramIdx++}`); params.push(name); }
    if (description !== undefined) { updates.push(`description = $${paramIdx++}`); params.push(description); }
    if (settings) { updates.push(`settings = $${paramIdx++}`); params.push(JSON.stringify(settings)); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    params.push(orgId);

    const result = await pool.query(
      `UPDATE organizations SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );

    // 감사 로그
    await pool.query(
      'INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
      [orgId, userId, 'update', 'organization', orgId, JSON.stringify({ updatedFields: Object.keys(req.body).filter(k => k !== 'userId') })]
    );

    res.json({ organization: result.rows[0] });
  } catch (e) {
    console.error('Update organization error:', e);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

// 조직 삭제 (owner만)
app.delete('/api/organizations/:orgId', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // 권한 확인
    const roleResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    if (roleResult.rows[0]?.role !== 'owner') {
      return res.status(403).json({ error: 'Only owner can delete organization' });
    }

    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);

    // 감사 로그
    await pool.query(
      'INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4, $5)',
      [orgId, userId, 'delete', 'organization', orgId]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('Delete organization error:', e);
    res.status(500).json({ error: 'Failed to delete organization' });
  }
});

// 조직 멤버 초대
app.post('/api/organizations/:orgId/invites', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { userId, email, role } = req.body;
    if (!userId || !email) return res.status(400).json({ error: 'userId and email required' });

    // 권한 확인
    const roleResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    const userRole = roleResult.rows[0]?.role;
    if (!userRole || !['owner', 'admin'].includes(userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7일

    await pool.query(
      'INSERT INTO organization_invites (organization_id, email, role, token, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [orgId, email, role || 'member', token, userId, expiresAt]
    );

    const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:8082'}/org/invite/${token}`;

    res.json({ invite: { email, role, token, expiresAt, inviteUrl } });
  } catch (e) {
    console.error('Create invite error:', e);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// 초대 수락
app.post('/api/organizations/invites/:token/accept', async (req, res) => {
  try {
    const { token } = req.params;
    const { userId, name } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const inviteResult = await pool.query(
      'SELECT * FROM organization_invites WHERE token = $1 AND expires_at > NOW() AND accepted_at IS NULL',
      [token]
    );
    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired invite' });
    }
    const invite = inviteResult.rows[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 사용자 생성/확인
      let userResult = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length === 0) {
        const color = '#4ECDC4';
        await client.query('INSERT INTO users (id, name, color) VALUES ($1, $2, $3)', [userId, name || 'User', color]);
      }

      // 멤버십 추가
      await client.query(
        'INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role',
        [invite.organization_id, userId, invite.role]
      );

      // 초대 수락 처리
      await client.query('UPDATE organization_invites SET accepted_at = NOW() WHERE token = $1', [token]);

      // 감사 로그
      await client.query(
        'INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4, $5)',
        [invite.organization_id, userId, 'accept_invite', 'organization', invite.organization_id]
      );

      await client.query('COMMIT');
      res.json({ success: true, organizationId: invite.organization_id });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Accept invite error:', e);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// 멤버 역할 변경 (owner/admin만)
app.patch('/api/organizations/:orgId/members/:memberId', async (req, res) => {
  try {
    const { orgId, memberId } = req.params;
    const { userId, role } = req.body;
    if (!userId || !role) return res.status(400).json({ error: 'userId and role required' });

    // 요청자 권한 확인
    const requesterRoleResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    const requesterRole = requesterRoleResult.rows[0]?.role;
    if (!requesterRole || !['owner', 'admin'].includes(requesterRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // 대상 멤버 확인
    const targetResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, memberId]
    );
    if (targetResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    const targetRole = targetResult.rows[0].role;

    // owner는 owner만 변경 가능, admin은 member/viewer만 변경 가능
    if (targetRole === 'owner' && requesterRole !== 'owner') {
      return res.status(403).json({ error: 'Cannot modify owner role' });
    }
    if (targetRole === 'admin' && requesterRole !== 'owner') {
      return res.status(403).json({ error: 'Cannot modify admin role' });
    }
    if (role === 'owner' && requesterRole !== 'owner') {
      return res.status(403).json({ error: 'Cannot assign owner role' });
    }
    if (role === 'admin' && requesterRole !== 'owner') {
      return res.status(403).json({ error: 'Cannot assign admin role' });
    }

    await pool.query(
      'UPDATE organization_members SET role = $1 WHERE organization_id = $2 AND user_id = $3',
      [role, orgId, memberId]
    );

    // 감사 로그
    await pool.query(
      'INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
      [orgId, userId, 'update_role', 'member', memberId, JSON.stringify({ oldRole: targetRole, newRole: role })]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('Update member role error:', e);
    res.status(500).json({ error: 'Failed to update member role' });
  }
});

// 멤버 삭제 (owner/admin만, 자기 자신은 삭제 불가)
app.delete('/api/organizations/:orgId/members/:memberId', async (req, res) => {
  try {
    const { orgId, memberId } = req.params;
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (userId === memberId) return res.status(400).json({ error: 'Cannot remove yourself' });

    // 권한 확인
    const roleResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    const userRole = roleResult.rows[0]?.role;
    if (!userRole || !['owner', 'admin'].includes(userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // 대상 권한 확인
    const targetResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, memberId]
    );
    if (targetResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if (targetResult.rows[0].role === 'owner') {
      return res.status(403).json({ error: 'Cannot remove owner' });
    }

    await pool.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, memberId]);

    // 감사 로그
    await pool.query(
      'INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4, $5)',
      [orgId, userId, 'remove_member', 'member', memberId]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('Remove member error:', e);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// 방을 조직에 연결
app.post('/api/organizations/:orgId/rooms', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { userId, roomId } = req.body;
    if (!userId || !roomId) return res.status(400).json({ error: 'userId and roomId required' });

    // 권한 확인
    const roleResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    if (!['owner', 'admin', 'member'].includes(roleResult.rows[0]?.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    await pool.query(
      'INSERT INTO room_organizations (room_id, organization_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [roomId, orgId]
    );

    // 감사 로그
    await pool.query(
      'INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4, $5)',
      [orgId, userId, 'add_room', 'room', roomId]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('Add room to org error:', e);
    res.status(500).json({ error: 'Failed to add room to organization' });
  }
});

// 방을 조직에서 제거
app.delete('/api/organizations/:orgId/rooms/:roomId', async (req, res) => {
  try {
    const { orgId, roomId } = req.params;
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const roleResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    if (!['owner', 'admin'].includes(roleResult.rows[0]?.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    await pool.query('DELETE FROM room_organizations WHERE room_id = $1 AND organization_id = $2', [roomId, orgId]);

    // 감사 로그
    await pool.query(
      'INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4, $5)',
      [orgId, userId, 'remove_room', 'room', roomId]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('Remove room from org error:', e);
    res.status(500).json({ error: 'Failed to remove room from organization' });
  }
});

// 감사 로그 조회 (owner/admin만)
app.get('/api/organizations/:orgId/audit-logs', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { userId, limit = 100, offset = 0 } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const roleResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    if (!['owner', 'admin'].includes(roleResult.rows[0]?.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const result = await pool.query(
      'SELECT * FROM audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [orgId, limit, offset]
    );

    res.json({ logs: result.rows });
  } catch (e) {
    console.error('Fetch audit logs error:', e);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// 기본 시스템 역할 초기화
async function initializeSystemRoles() {
  if (!dbAvailable) return;
  try {
    const systemRoles = [
      { id: 'owner', name: 'Owner', description: 'Full access to organization', permissions: ['*'], is_system: true },
      { id: 'admin', name: 'Admin', description: 'Administrative access', permissions: ['manage_members', 'manage_rooms', 'manage_settings', 'view_audit'], is_system: true },
      { id: 'member', name: 'Member', description: 'Standard member', permissions: ['create_rooms', 'join_rooms', 'view_members'], is_system: true },
      { id: 'viewer', name: 'Viewer', description: 'Read-only access', permissions: ['view_rooms', 'view_members'], is_system: true }
    ];

    for (const role of systemRoles) {
      await pool.query(
        'INSERT INTO roles (id, name, description, permissions, is_system) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions',
        [role.id, role.name, role.description, JSON.stringify(role.permissions), role.is_system]
      );
    }
    console.log('System roles initialized');
  } catch (e) {
    console.error('Role initialization error:', e);
  }
}

// setupDatabase 완료 후 호출
initializeSystemRoles().catch(console.error);

// ============================================
// 푸시 알림 API
// ============================================

// Push 구독 저장 테이블 생성 (setupDatabase에 추가 필요)
const PUSH_SUBSCRIPTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, endpoint)
  );
`;

// 푸시 구독 저장
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { userId, subscription } = req.body;
    if (!userId || !subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'userId and subscription required' });
    }

    // 테이블 확인/생성
    await pool.query(PUSH_SUBSCRIPTIONS_TABLE);

    const keys = subscription.keys || {};
    await pool.query(
      'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent',
      [userId, subscription.endpoint, keys.p256dh || '', keys.auth || '', req.headers['user-agent'] || '']
    );

    res.json({ success: true });
  } catch (e) {
    console.error('Push subscribe error:', e);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

// 푸시 구독 해제
app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { userId, endpoint } = req.body;
    if (!userId || !endpoint) {
      return res.status(400).json({ error: 'userId and endpoint required' });
    }

    await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
    res.json({ success: true });
  } catch (e) {
    console.error('Push unsubscribe error:', e);
    res.status(500).json({ error: 'Failed to remove push subscription' });
  }
});

// 푸시 알림 발송 (관리자/시스템용)
const webpush = require('web-push');
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BEl62iUYgUivxIkv69yViEuiBIa40HI80NM9fY7s5eDg8qVhKsLGhQ9k5z';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'your-vapid-private-key';

webpush.setVapidDetails(
  'mailto:admin@tev1.local',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// 특정 사용자에게 푸시 발송
app.post('/api/push/send', async (req, res) => {
  try {
    const { userId, title, body, data, icon, badge } = req.body;
    if (!userId || !title) {
      return res.status(400).json({ error: 'userId and title required' });
    }

    const result = await pool.query(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No push subscriptions for user' });
    }

    const notifications = result.rows.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };

      const payload = JSON.stringify({
        title,
        body: body || '',
        icon: icon || '/icon-192.png',
        badge: badge || '/badge-72.png',
        vibrate: [200, 100, 200],
        data: data || {},
        actions: [
          { action: 'open', title: '열기' },
          { action: 'dismiss', title: '닫기' }
        ],
        requireInteraction: true
      });

      try {
        await webpush.sendNotification(pushSubscription, payload);
        return { success: true, endpoint: sub.endpoint };
      } catch (e) {
        // 구독 만료 시 삭제
        if (e.statusCode === 410 || e.statusCode === 404) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        }
        return { success: false, endpoint: sub.endpoint, error: e.message };
      }
    });

    const results = await Promise.all(notifications);
    res.json({ sent: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, details: results });
  } catch (e) {
    console.error('Push send error:', e);
    res.status(500).json({ error: 'Failed to send push notification' });
  }
});

// 전체 사용자에게 브로드캐스트 푸시 (관리자용)
app.post('/api/push/broadcast', async (req, res) => {
  try {
    const { title, body, data, icon, badge, role } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    let query = 'SELECT endpoint, p256dh, auth FROM push_subscriptions';
    const params = [];

    if (role) {
      // 특정 역할의 사용자만 (organization_members 조인 필요)
      query += ' WHERE user_id IN (SELECT user_id FROM organization_members WHERE role = $1)';
      params.push(role);
    }

    const result = await pool.query(query, params);

    const notifications = result.rows.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };

      const payload = JSON.stringify({
        title,
        body: body || '',
        icon: icon || '/icon-192.png',
        badge: badge || '/badge-72.png',
        data: data || {},
        actions: [{ action: 'open', title: '열기' }, { action: 'dismiss', title: '닫기' }],
        requireInteraction: true
      });

      try {
        await webpush.sendNotification(pushSubscription, payload);
        return { success: true };
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        }
        return { success: false, error: e.message };
      }
    });

    const results = await Promise.all(notifications);
    res.json({ sent: results.filter(r => r.success).length, total: results.length });
  } catch (e) {
    console.error('Push broadcast error:', e);
    res.status(500).json({ error: 'Failed to broadcast push notification' });
  }
});

// ============================================
// 분석 대시보드 API
// ============================================

// 회의 통계 요약
app.get('/api/analytics/meetings/summary', async (req, res) => {
  try {
    const { orgId, startDate, endDate, userId } = req.query;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });

    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const end = endDate || new Date().toISOString();

    const totalMeetings = await pool.query(`
      SELECT COUNT(DISTINCT r.id) as count
      FROM rooms r
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE ro.organization_id = $1 AND r.created_at BETWEEN $2 AND $3
    `, [orgId, start, end]);

    const totalParticipants = await pool.query(`
      SELECT COUNT(DISTINCT ru.user_id) as count
      FROM room_users ru
      JOIN rooms r ON ru.room_id = r.id
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE ro.organization_id = $1 AND r.created_at BETWEEN $2 AND $3
    `, [orgId, start, end]);

    const totalMessages = await pool.query(`
      SELECT COUNT(*) as count
      FROM messages m
      JOIN rooms r ON m.room_id = r.id
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE ro.organization_id = $1 AND m.created_at BETWEEN $2 AND $3
    `, [orgId, start, end]);

    const avgDuration = await pool.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (MAX(m.created_at) - MIN(m.created_at)))/60) as avg_minutes
      FROM messages m
      JOIN rooms r ON m.room_id = r.id
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE ro.organization_id = $1 AND r.created_at BETWEEN $2 AND $3
      GROUP BY r.id
    `, [orgId, start, end]);

    const dailyMeetings = await pool.query(`
      SELECT DATE(r.created_at) as date, COUNT(DISTINCT r.id) as count
      FROM rooms r
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE ro.organization_id = $1 AND r.created_at BETWEEN $2 AND $3
      GROUP BY DATE(r.created_at)
      ORDER BY date
    `, [orgId, start, end]);

    const topUsers = await pool.query(`
      SELECT u.id, u.name, u.color, COUNT(DISTINCT m.id) as message_count, COUNT(DISTINCT r.id) as meeting_count
      FROM users u
      JOIN messages m ON u.id = m.user_id
      JOIN rooms r ON m.room_id = r.id
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE ro.organization_id = $1 AND m.created_at BETWEEN $2 AND $3
      GROUP BY u.id, u.name, u.color
      ORDER BY message_count DESC
      LIMIT 10
    `, [orgId, start, end]);

    res.json({
      period: { start, end },
      totalMeetings: parseInt(totalMeetings.rows[0].count),
      totalParticipants: parseInt(totalParticipants.rows[0].count),
      totalMessages: parseInt(totalMessages.rows[0].count),
      avgMeetingDurationMinutes: Math.round(avgDuration.rows[0]?.avg_minutes || 0),
      dailyMeetings: dailyMeetings.rows,
      topUsers: topUsers.rows
    });
  } catch (e) {
    console.error('Analytics summary error:', e);
    res.status(500).json({ error: 'Failed to fetch analytics summary' });
  }
});

// 사용자별 생산성 지표
app.get('/api/analytics/users/:userId/productivity', async (req, res) => {
  try {
    const { userId } = req.params;
    const { orgId, startDate, endDate } = req.query;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });

    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const end = endDate || new Date().toISOString();

    const userResult = await pool.query('SELECT id, name, color FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const meetings = await pool.query(`
      SELECT 
        COUNT(DISTINCT r.id) as meetings_attended,
        COUNT(DISTINCT m.id) as messages_sent,
        AVG(EXTRACT(EPOCH FROM (MAX(m.created_at) - MIN(m.created_at)))/60) as avg_duration_minutes,
        COUNT(DISTINCT CASE WHEN m.created_at::date = CURRENT_DATE THEN r.id END) as meetings_today
      FROM rooms r
      JOIN room_organizations ro ON r.id = ro.room_id
      LEFT JOIN messages m ON r.id = m.room_id AND m.user_id = $1
      JOIN room_users ru ON r.id = ru.room_id
      WHERE ro.organization_id = $2 AND ru.user_id = $1 AND r.created_at BETWEEN $3 AND $4
    `, [userId, orgId, start, end]);

    const dailyActivity = await pool.query(`
      SELECT DATE(m.created_at) as date, COUNT(*) as message_count
      FROM messages m
      JOIN rooms r ON m.room_id = r.id
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE m.user_id = $1 AND ro.organization_id = $2 AND m.created_at BETWEEN $3 AND $4
      GROUP BY DATE(m.created_at)
      ORDER BY date
    `, [userId, orgId, start, end]);

    const hourlyActivity = await pool.query(`
      SELECT EXTRACT(HOUR FROM m.created_at) as hour, COUNT(*) as count
      FROM messages m
      JOIN rooms r ON m.room_id = r.id
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE m.user_id = $1 AND ro.organization_id = $2 AND m.created_at BETWEEN $3 AND $4
      GROUP BY EXTRACT(HOUR FROM m.created_at)
      ORDER BY hour
    `, [userId, orgId, start, end]);

    const collaborators = await pool.query(`
      SELECT u.id, u.name, u.color, COUNT(DISTINCT r.id) as shared_meetings
      FROM users u
      JOIN room_users ru1 ON u.id = ru1.user_id
      JOIN room_users ru2 ON ru1.room_id = ru2.room_id
      JOIN rooms r ON ru1.room_id = r.id
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE ru2.user_id = $1 AND ro.organization_id = $2 AND r.created_at BETWEEN $3 AND $4 AND u.id != $1
      GROUP BY u.id, u.name, u.color
      ORDER BY shared_meetings DESC
      LIMIT 10
    `, [userId, orgId, start, end]);

    res.json({
      user: userResult.rows[0],
      period: { start, end },
      meetingsAttended: parseInt(meetings.rows[0].meetings_attended),
      messagesSent: parseInt(meetings.rows[0].messages_sent),
      avgMeetingDurationMinutes: Math.round(meetings.rows[0].avg_duration_minutes || 0),
      meetingsToday: parseInt(meetings.rows[0].meetings_today),
      dailyActivity: dailyActivity.rows,
      hourlyActivity: hourlyActivity.rows,
      topCollaborators: collaborators.rows
    });
  } catch (e) {
    console.error('User productivity error:', e);
    res.status(500).json({ error: 'Failed to fetch user productivity' });
  }
});

// 조직 전체 생산성 트렌드
app.get('/api/analytics/organizations/:orgId/trends', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { period = '30d' } = req.query;

    const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 30;
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date().toISOString();

    const dailyTrends = await pool.query(`
      SELECT 
        DATE(r.created_at) as date,
        COUNT(DISTINCT r.id) as meetings,
        COUNT(DISTINCT m.id) as messages,
        COUNT(DISTINCT ru.user_id) as participants
      FROM rooms r
      JOIN room_organizations ro ON r.id = ro.room_id
      LEFT JOIN messages m ON r.id = m.room_id
      LEFT JOIN room_users ru ON r.id = ru.room_id
      WHERE ro.organization_id = $1 AND r.created_at BETWEEN $2 AND $3
      GROUP BY DATE(r.created_at)
      ORDER BY date
    `, [orgId, start, end]);

    const thisWeekStart = new Date();
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
    const lastWeekStart = new Date(thisWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    const weeklyComparison = await pool.query(`
      SELECT 
        'this_week' as period,
        COUNT(DISTINCT r.id) as meetings,
        COUNT(DISTINCT m.id) as messages,
        COUNT(DISTINCT ru.user_id) as participants
      FROM rooms r
      JOIN room_organizations ro ON r.id = ro.room_id
      LEFT JOIN messages m ON r.id = m.room_id
      LEFT JOIN room_users ru ON r.id = ru.room_id
      WHERE ro.organization_id = $1 AND r.created_at >= $2
      UNION ALL
      SELECT 
        'last_week' as period,
        COUNT(DISTINCT r.id) as meetings,
        COUNT(DISTINCT m.id) as messages,
        COUNT(DISTINCT ru.user_id) as participants
      FROM rooms r
      JOIN room_organizations ro ON r.id = ro.room_id
      LEFT JOIN messages m ON r.id = m.room_id
      LEFT JOIN room_users ru ON r.id = ru.room_id
      WHERE ro.organization_id = $1 AND r.created_at >= $3 AND r.created_at < $2
    `, [orgId, thisWeekStart.toISOString(), lastWeekStart.toISOString()]);

    const topRooms = await pool.query(`
      SELECT r.id, r.name, COUNT(DISTINCT m.id) as message_count, COUNT(DISTINCT ru.user_id) as participant_count
      FROM rooms r
      JOIN room_organizations ro ON r.id = ro.room_id
      LEFT JOIN messages m ON r.id = m.room_id
      LEFT JOIN room_users ru ON r.id = ru.room_id
      WHERE ro.organization_id = $1 AND r.created_at BETWEEN $2 AND $3
      GROUP BY r.id, r.name
      ORDER BY message_count DESC
      LIMIT 10
    `, [orgId, start, end]);

    res.json({
      organizationId: orgId,
      period: { start, end, days },
      dailyTrends: dailyTrends.rows,
      weeklyComparison: weeklyComparison.rows,
      topRooms: topRooms.rows
    });
  } catch (e) {
    console.error('Organization trends error:', e);
    res.status(500).json({ error: 'Failed to fetch organization trends' });
  }
});

// 실시간 대시보드 데이터
app.get('/api/analytics/realtime', async (req, res) => {
  try {
    const { orgId } = req.query;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });

    const activeMeetings = await pool.query(`
      SELECT r.id, r.name, COUNT(DISTINCT ru.user_id) as current_participants
      FROM rooms r
      JOIN room_organizations ro ON r.id = ro.room_id
      JOIN room_users ru ON r.id = ru.room_id
      WHERE ro.organization_id = $1
      GROUP BY r.id, r.name
      HAVING COUNT(DISTINCT ru.user_id) > 0
      ORDER BY current_participants DESC
    `, [orgId]);

    const recentMessages = await pool.query(`
      SELECT m.id, m.content, m.created_at, u.name, u.color, r.id as room_id, r.name as room_name
      FROM messages m
      JOIN users u ON m.user_id = u.id
      JOIN rooms r ON m.room_id = r.id
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE ro.organization_id = $1 AND m.created_at > NOW() - INTERVAL '5 minutes'
      ORDER BY m.created_at DESC
      LIMIT 20
    `, [orgId]);

    const onlineUsers = await pool.query(`
      SELECT COUNT(DISTINCT ru.user_id) as count
      FROM room_users ru
      JOIN rooms r ON ru.room_id = r.id
      JOIN room_organizations ro ON r.id = ro.room_id
      WHERE ro.organization_id = $1
    `, [orgId]);

    res.json({
      timestamp: new Date().toISOString(),
      organizationId: orgId,
      activeMeetings: activeMeetings.rows.map(m => ({
        id: m.id,
        name: m.name,
        participants: parseInt(m.current_participants)
      })),
      recentMessages: recentMessages.rows,
      onlineUsers: parseInt(onlineUsers.rows[0].count)
    });
  } catch (e) {
    console.error('Realtime analytics error:', e);
    res.status(500).json({ error: 'Failed to fetch realtime analytics' });
  }
});

// 감사 로그 분석
app.get('/api/analytics/audit', async (req, res) => {
  try {
    const { orgId, startDate, endDate, action, userId } = req.query;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });

    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const end = endDate || new Date().toISOString();

    let query = `
      SELECT al.*, u.name as user_name
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE al.organization_id = $1 AND al.created_at BETWEEN $2 AND $3
    `;
    const params = [orgId, start, end];
    let paramIdx = 4;

    if (action) {
      query += ` AND al.action = $${paramIdx++}`;
      params.push(action);
    }
    if (userId) {
      query += ` AND al.user_id = $${paramIdx++}`;
      params.push(userId);
    }

    query += ` ORDER BY al.created_at DESC LIMIT 500`;

    const result = await pool.query(query, params);

    const actionStats = await pool.query(`
      SELECT action, COUNT(*) as count
      FROM audit_logs
      WHERE organization_id = $1 AND created_at BETWEEN $2 AND $3
      GROUP BY action
      ORDER BY count DESC
    `, [orgId, start, end]);

    const dailyActions = await pool.query(`
      SELECT DATE(created_at) as date, action, COUNT(*) as count
      FROM audit_logs
      WHERE organization_id = $1 AND created_at BETWEEN $2 AND $3
      GROUP BY DATE(created_at), action
      ORDER BY date DESC, count DESC
    `, [orgId, start, end]);

    res.json({
      organizationId: orgId,
      period: { start, end },
      logs: result.rows,
      actionStats: actionStats.rows,
      dailyActions: dailyActions.rows
    });
  } catch (e) {
    console.error('Audit analytics error:', e);
    res.status(500).json({ error: 'Failed to fetch audit analytics' });
  }
});

// 메트릭 엔드포인트 (Prometheus용)
app.get('/metrics', async (req, res) => {
  try {
    if (!dbAvailable) {
      return res.status(503).type('text/plain').send('# Database unavailable\n');
    }

    const [
      userCount,
      orgCount,
      roomCount,
      messageCount,
      activeRooms
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM users'),
      pool.query('SELECT COUNT(*) as count FROM organizations'),
      pool.query('SELECT COUNT(*) as count FROM rooms'),
      pool.query('SELECT COUNT(*) as count FROM messages'),
      pool.query('SELECT COUNT(DISTINCT r.id) as count FROM rooms r JOIN room_users ru ON r.id = ru.room_id WHERE ru.user_id IS NOT NULL')
    ]);

    const metrics = [
      `# HELP tev1_users_total Total number of users`,
      `# TYPE tev1_users_total gauge`,
      `tev1_users_total ${userCount.rows[0].count}`,
      ``,
      `# HELP tev1_organizations_total Total number of organizations`,
      `# TYPE tev1_organizations_total gauge`,
      `tev1_organizations_total ${orgCount.rows[0].count}`,
      ``,
      `# HELP tev1_rooms_total Total number of rooms`,
      `# TYPE tev1_rooms_total gauge`,
      `tev1_rooms_total ${roomCount.rows[0].count}`,
      ``,
      `# HELP tev1_messages_total Total number of messages`,
      `# TYPE tev1_messages_total counter`,
      `tev1_messages_total ${messageCount.rows[0].count}`,
      ``,
      `# HELP tev1_active_rooms Current active rooms`,
      `# TYPE tev1_active_rooms gauge`,
      `tev1_active_rooms ${activeRooms.rows[0].count}`,
      ``,
      `# HELP tev1_uptime_seconds Server uptime in seconds`,
      `# TYPE tev1_uptime_seconds counter`,
      `tev1_uptime_seconds ${process.uptime()}`,
      ``
    ].join('\n');

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics);
  } catch (e) {
    console.error('Metrics error:', e);
    res.status(500).type('text/plain').send('# Error generating metrics\n');
  }
});

// Graceful shutdown handling
async function gracefulShutdown(signal) {
  console.log(`Received ${signal}, starting graceful shutdown...`);
  
  // Close WebSocket connections
  wss.clients.forEach(ws => {
    ws.close(1001, 'Server shutting down');
  });
  
  // Close Socket.IO
  await io.close();
  
  // Close HTTP server
  server.close(async () => {
    console.log('HTTP server closed');
    
    // Close PostgreSQL pool
    await pool.end();
    console.log('PostgreSQL pool closed');
    
    // Close Redis connection
    await redis.quit();
    console.log('Redis connection closed');
    
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  gracefulShutdown('unhandledRejection');
});

// Start server
const PORT = process.env.PORT || 8081;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`REST API: http://localhost:${PORT}`);
  console.log(`Socket.IO endpoint: http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Detailed health: http://localhost:${PORT}/health/detailed`);
});

module.exports = { app, server, io, pool, redis };