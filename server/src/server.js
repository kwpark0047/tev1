require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Server } = require('socket.io');
const {
  hashPassword,
  verifyPassword,
  validatePassword,
  validateUserId,
  dummyVerify,
} = require('./auth');

const app = express();
const server = http.createServer(app);

// Express 미들웨어 (누락 시 모든 POST/PATCH/DELETE body 파싱이 실패한다)
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()),
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// 보안 헤더 (외부 의존성 없이 직접 설정)
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-XSS-Protection', '0'); // 구식 필터는 취약점을 만들 수 있어 비활성화
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' http://localhost:8081; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss: http://localhost:8081; " +
      "media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
  );
  if (String(req.secure) === 'true') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  }
});

// PostgreSQL connection pool with optimized settings
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://tev1@localhost:5432/tev1',
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
  // Redis가 없어도 프로세스가 죽지 않도록 에러를 흡수한다
  retryOnFailure: false,
});

// ioredis는 error 핸들러가 없으면 unhandled error로 프로세스를 죽인다
redis.on('error', (err) => {
  if (redisAvailable) {
    console.warn('Redis error:', err.message);
  }
  redisAvailable = false;
});
redis.on('end', () => { redisAvailable = false; });
redis.on('ready', () => { redisAvailable = true; });

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
    // 이미 연결 중이거나 연결된 경우 connect()를 다시 부르면 예외가 된다
    if (redis.status !== 'ready' && redis.status !== 'connecting') {
      await redis.connect();
    }
    if (redis.status !== 'ready') {
      // connect()가 완료될 때까지 대기 (타임아웃 적용)
      await Promise.race([
        new Promise((resolve) => redis.once('ready', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connect timeout')), 3000)),
      ]);
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
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'offline';
        -- 인증 컬럼 (비밀번호 해시, 활성/비활성, 로그인 추적)
        ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INTEGER DEFAULT 0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(320);

        -- 세션 관리 (로그아웃/강제 만료 지원)
        CREATE TABLE IF NOT EXISTS auth_sessions (
          jti VARCHAR(64) PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          user_agent TEXT,
          ip_address INET,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

        -- 로그인 실패 감사 (브루트포스 탐지/대응에 사용)
        CREATE TABLE IF NOT EXISTS login_attempts (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255),
          ip_address INET,
          success BOOLEAN NOT NULL,
          reason TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_login_attempts_user_time ON login_attempts(user_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS rooms (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS room_users (
          room_id VARCHAR(255) REFERENCES rooms(id) ON DELETE CASCADE,
          user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
          joined_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (room_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          room_id VARCHAR(255) REFERENCES rooms(id) ON DELETE CASCADE,
          user_id VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS cursors (
          room_id VARCHAR(255) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (room_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS user_tokens (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
          provider VARCHAR(50) NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expiry BIGINT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
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
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- 조직 멤버십 (사용자-조직 연결)
        CREATE TABLE IF NOT EXISTS organization_members (
          id SERIAL PRIMARY KEY,
          organization_id VARCHAR(255) REFERENCES organizations(id) ON DELETE CASCADE,
          user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
          role VARCHAR(50) NOT NULL DEFAULT 'member', -- owner, admin, member, viewer
          joined_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(organization_id, user_id)
        );

        -- 역할(Role) 정의
        CREATE TABLE IF NOT EXISTS roles (
          id VARCHAR(50) PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          permissions JSONB NOT NULL DEFAULT '[]', -- 권한 목록
          is_system BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW()
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
          created_at TIMESTAMPTZ DEFAULT NOW()
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
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(organization_id);
        CREATE INDEX IF NOT EXISTS idx_room_orgs_room ON room_organizations(room_id);
        CREATE INDEX IF NOT EXISTS idx_room_orgs_org ON room_organizations(organization_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(organization_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_invites_token ON organization_invites(token);
        CREATE INDEX IF NOT EXISTS idx_invites_email ON organization_invites(email);

        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          endpoint TEXT NOT NULL,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          user_agent TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, endpoint)
        );
        CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
      `);

      // 이전 스키마(timestamp without time zone)를 timestamptz로 승격한다.
      // Node는 UTC ISO 문자열을 보내므로, 로컬 timestamp와 비교하면 경계가 어긋나
      // 조회 결과가 0건이 되는 문제가 있다.
      await migrateTimestampsToTimestamptz(client);
      console.log('Database tables created/verified');
      dbAvailable = true;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Database setup failed, running in memory-only mode:', e.message);
    dbAvailable = false;
  }
  
  // Try Redis connection (헬스체크 헬퍼가 상태 전이를 처리한다)
  if (await checkRedisHealth()) {
    console.log('Redis connected');
  } else {
    console.warn('Redis unavailable, running without cache');
    redisAvailable = false;
  }
}

/** timestamp 컬럼을 timestamptz로 승격 (UTC 기준으로 재해석) */
async function migrateTimestampsToTimestamptz(client) {
  const targets = {
    users: ['created_at'],
    rooms: ['created_at'],
    room_users: ['joined_at'],
    messages: ['created_at'],
    cursors: ['updated_at'],
    user_tokens: ['created_at'],
    organizations: ['created_at', 'updated_at'],
    organization_members: ['joined_at'],
    organization_invites: ['expires_at', 'accepted_at', 'created_at'],
    audit_logs: ['created_at'],
    push_subscriptions: ['created_at'],
    users: ['created_at', 'last_login_at', 'locked_until'],
    auth_sessions: ['created_at', 'expires_at', 'revoked_at'],
    login_attempts: ['created_at'],
  };

  for (const [table, cols] of Object.entries(targets)) {
    for (const col of cols) {
      const typeRes = await client.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, col]
      );
      if (typeRes.rows.length === 0 || typeRes.rows[0].data_type !== 'timestamp without time zone') {
        continue;
      }
      // 기존 값은 UTC로 저장되어 있었으므로 UTC 기준을 명시하고 timestamptz로 승격
      await client.query(
        `ALTER TABLE ${table} ALTER COLUMN ${col}
         TYPE TIMESTAMPTZ USING ${col} AT TIME ZONE 'UTC'`
      );
      console.log(`Migrated ${table}.${col} -> timestamptz`);
    }
  }
}

// 스키마 초기화 (DB 미가용이어도 서버는 계속 기동)
// 기본 역할 시드는 테이블 생성 이후에만 안전하게 삽입할 수 있다
const bootstrapPromise = setupDatabase()
  .then(async () => {
    await initializeSystemRoles();
  })
  .catch((e) => {
    console.error('setupDatabase failed:', e.message);
    dbAvailable = false;
  });

// Socket.IO Redis adapter for scaling (Redis 가용 시에만 활성화)
(async () => {
  const redisOk = await checkRedisHealth();
  if (!redisOk) {
    console.warn('Redis adapter disabled - running single-node Socket.IO');
    return;
  }
  try {
    const pubClient = redis.duplicate();
    const subClient = redis.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    console.log('Socket.IO Redis adapter enabled');
  } catch (e) {
    console.warn('Redis adapter setup failed:', e.message);
  }
})();

// In-memory presence (실시간 커서/참가자 상태)
// 방 상태는 Redis로 공유하며, Redis 미가용 시 이 맵을 사용한다
const rooms = new Map(); // roomId -> { users: Map<userId, {id,name,color}>, cursors: Map<userId,{x,y}> }

const JWT_SECRET = process.env.JWT_SECRET || 'tev1-secret-key-change-in-production';

// JWT를 Authorization 헤더 또는 쿼리/바디에서 추출한다
function extractToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (header && typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  if (req.body && typeof req.body.token === 'string') return req.body.token;
  return null;
}

// 인증 필수 미들웨어
// - userId를 쿼리스트링/바디로 받지 않고 JWT에서만 신뢰한다
// - 서명뿐 아니라 DB 세션(폐기·만료)도 확인하므로 로그아웃/비밀번호 변경이 즉시 반영된다
function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: '로그인이 필요합니다.', code: 'NO_TOKEN' });
  }
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: '세션이 만료되었거나 유효하지 않습니다.', code: 'INVALID_TOKEN' });
  }

  isSessionActive(decoded)
    .then((active) => {
      if (!active) {
        return res.status(401).json({ error: '세션이 종료되었습니다. 다시 로그인하세요.', code: 'SESSION_REVOKED' });
      }
      req.user = { id: decoded.userId, name: decoded.name };
      req.sessionId = decoded.jti;
      // 하위 핸들러가 기존 userId 파라미터를 쓰므로 덮어써 신뢰 경로를 제거한다
      if (req.query) req.query.userId = decoded.userId;
      if (req.body) req.body.userId = decoded.userId;
      next();
    })
    .catch(() => {
      res.status(401).json({ error: '인증 확인에 실패했습니다.', code: 'AUTH_CHECK_FAILED' });
    });
}

// DB 필요 미들웨어: 가용하지 않으면 500이 아니라 503으로 명확히 알린다
function requireDb(req, res, next) {
  if (!dbAvailable) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }
  next();
}

// 운영 환경에서 약한 기본 비밀키 사용을 경고한다
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production');
  process.exit(1);
}

// Generate random color for user
function getRandomColor() {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFBE0B', '#FB5607',
    '#8338EC', '#3A86FF', '#06D6A0', '#FF006E', '#FB8500'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// 세션 수명 (기본 12시간)
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);

// JWT 발급: jti를 넣어 개별 세션 폐기(로그아웃)를 가능하게 한다
function generateToken(userId, name, jti) {
  return jwt.sign({ userId, name, jti }, JWT_SECRET, { expiresIn: `${SESSION_TTL_HOURS}h` });
}

// JWT 검증 (서명/만료 확인)
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// 세션 발급: JWT + DB 세션 레코드(jti) 생성
async function issueSession({ userId, name }, req) {
  const jti = uuidv4();
  const token = generateToken(userId, name, jti);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  try {
    await pool.query(
      `INSERT INTO auth_sessions (jti, user_id, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [jti, userId, (req && req.headers['user-agent']) || null, clientIp(req), expiresAt]
    );
  } catch (e) {
    console.error('issueSession persist failed:', e.message);
  }
  return token;
}

// 세션 유효성 확인 (폐기/만료 여부)
async function isSessionActive(decoded) {
  if (!decoded || !decoded.jti) return false;
  try {
    const r = await pool.query(
      'SELECT 1 FROM auth_sessions WHERE jti = $1 AND revoked_at IS NULL AND expires_at > NOW()',
      [decoded.jti]
    );
    return r.rows.length > 0;
  } catch (e) {
    // DB를 확인할 수 없으면 서명만 유효한 토큰을 허용하지 않는다(안전 우선)
    console.error('isSessionActive failed:', e.message);
    return false;
  }
}

// 클라이언트 IP 추출 (프록시 환경 대응)
function clientIp(req) {
  if (!req) return null;
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || req.socket && req.socket.remoteAddress || null;
}

// 로그인 시도 기록 (감사/브루트포스 탐지)
async function recordLoginAttempt(userId, req, success, reason) {
  if (!dbAvailable) return;
  try {
    await pool.query(
      'INSERT INTO login_attempts (user_id, ip_address, success, reason) VALUES ($1, $2, $3, $4)',
      [userId || null, clientIp(req), success, reason || null]
    );
  } catch (e) {
    // 감사 로그는 본 기능을 막지 않는다
  }
}

// ===================== 레이트리밋 =====================
// 의존성 없이 슬라이딩 윈도우 방식으로 구현한다.
const rateBuckets = new Map();

function rateLimit({ windowMs, max, key = (req) => clientIp(req), message }) {
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const hits = (rateBuckets.get(k) || []).filter((t) => now - t < windowMs);

    if (hits.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - hits[0])) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: message || '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
        code: 'RATE_LIMITED',
        retryAfter,
      });
    }

    hits.push(now);
    rateBuckets.set(k, hits);
    next();
  };
}

// 정리: 주기적으로 오래된 버킷 제거 (메모리 누수 방지)
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, hits] of rateBuckets.entries()) {
    const alive = hits.filter((t) => t > cutoff);
    if (alive.length === 0) rateBuckets.delete(k);
    else rateBuckets.set(k, alive);
  }
}, 10 * 60 * 1000).unref();

// 인증 관련 엔드포인트는 IP 기준으로 더 엄격하게 제한한다.
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: '로그인 시도가 너무 많습니다. 15분 후 다시 시도하세요.',
});

const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
});

// Store message in DB
async function storeMessage(roomId, userId, content) {
  if (!dbAvailable) return false;
  try {
    await pool.query(
      'INSERT INTO messages (room_id, user_id, content) VALUES ($1, $2, $3)',
      [roomId, userId, content]
    );
    return true;
  } catch (e) {
    console.error('Error storing message:', e.message);
    dbAvailable = false;
    return false;
  }
}

// 방 보장 (rooms 테이블에 없으면 생성) - 분석/조직 API가 참조하는 원본 데이터
async function ensureRoomRow(roomId, roomName) {
  if (!dbAvailable) return;
  try {
    await pool.query(
      'INSERT INTO rooms (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name',
      [roomId, roomName || roomId]
    );
  } catch (e) {
    console.error('ensureRoomRow failed:', e.message);
  }
}

// Handle new connection
io.on('connection', (socket) => {
  socket.data.peerConnections = new Map();

  // 인증: JWT 검증 후 방 입장 + 존재 보장
  socket.on('auth', async (data) => {
    const decoded = verifyToken(data && data.token);
    if (!decoded) {
      socket.emit('auth_error', { message: '유효하지 않은 세션입니다.' });
      socket.disconnect(true);
      return;
    }

    // REST와 동일하게 DB 세션 상태를 확인한다 (로그아웃 반영)
    if (!(await isSessionActive(decoded))) {
      socket.emit('auth_error', { message: '세션이 종료되었습니다. 다시 로그인하세요.', code: 'SESSION_REVOKED' });
      socket.disconnect(true);
      return;
    }

    const roomId = data.roomId || 'default';
    try {
      socket.userId = decoded.userId;
      socket.userName = decoded.name;
      socket.roomId = roomId;

      // 사용자 색상 조회/생성 (TDZ 버그 없이 결정)
      let color;
      if (dbAvailable) {
        const existing = await pool.query('SELECT color FROM users WHERE id = $1', [decoded.userId]);
        if (existing.rows.length === 0) {
          color = getRandomColor();
          await pool.query(
            'INSERT INTO users (id, name, color, status) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
            [decoded.userId, decoded.name, color, 'online']
          );
          const reread = await pool.query('SELECT color FROM users WHERE id = $1', [decoded.userId]);
          color = reread.rows[0] ? reread.rows[0].color : color;
        } else {
          color = existing.rows[0].color;
          await pool.query('UPDATE users SET status = $1 WHERE id = $2', ['online', decoded.userId]);
        }
      } else {
        color = getRandomColor();
      }

      await ensureRoomRow(roomId, decoded.name ? `${decoded.name}의 회의` : roomId);

      socket.join(`room-${roomId}`);

      if (!rooms.has(roomId)) {
        rooms.set(roomId, { users: new Map(), cursors: new Map() });
      }
      const room = rooms.get(roomId);
      room.users.set(decoded.userId, { id: decoded.userId, name: decoded.name, color });

      if (dbAvailable) {
        await pool.query(
          'INSERT INTO room_users (room_id, user_id) VALUES ($1, $2) ON CONFLICT (room_id, user_id) DO NOTHING',
          [roomId, decoded.userId]
        );
      }

      const users = Array.from(room.users.values()).map((u) => ({ id: u.id, name: u.name, color: u.color }));

      socket.emit('joined', { id: decoded.userId, name: decoded.name, color, users });
      socket.to(`room-${roomId}`).emit('user_joined', {
        userId: decoded.userId,
        name: decoded.name,
        color,
        users
      });

      // 저장된 커서 복원 (분석/재접속 대비)
      if (dbAvailable) {
        try {
          const cursors = await pool.query(
            'SELECT user_id, x, y FROM cursors WHERE room_id = $1',
            [roomId]
          );
          for (const c of cursors.rows) {
            room.cursors.set(c.user_id, { x: c.x, y: c.y });
          }
          socket.emit('cursor_broadcast', {
            cursors: Array.from(room.cursors.entries()).map(([uid, pos]) => ({
              userId: uid,
              x: pos.x,
              y: pos.y
            }))
          });
        } catch (e) {
          console.error('cursor restore failed:', e.message);
        }
      }
    } catch (e) {
      console.error('Auth error:', e);
      socket.emit('auth_error', { message: 'Auth failed' });
    }
  });

  // 인증 없이 방 입장 시도 (기존 클라이언트 호환)
  socket.on('join', async (data) => {
    if (socket.userId) return; // 이미 인증됨
    const roomId = data && data.roomId;
    if (!roomId) {
      socket.emit('error', { message: 'roomId required' });
      return;
    }
    socket.roomId = roomId;
    socket.userId = (data.name || 'guest') + '#' + socket.id.slice(0, 6);
    socket.userName = data.name || 'guest';
    socket.join(`room-${roomId}`);

    if (!rooms.has(roomId)) rooms.set(roomId, { users: new Map(), cursors: new Map() });
    const room = rooms.get(roomId);
    const color = getRandomColor();
    room.users.set(socket.userId, { id: socket.userId, name: socket.userName, color });
    await ensureRoomRow(roomId, `${socket.userName}의 회의`);

    socket.emit('joined', {
      id: socket.userId,
      name: socket.userName,
      color,
      users: Array.from(room.users.values()).map((u) => ({ id: u.id, name: u.name, color: u.color }))
    });
  });

  socket.on('cursor', (data) => {
    if (!socket.roomId) return;
    const room = rooms.get(socket.roomId);
    if (!room) return;

    const x = Number(data.x) || 0;
    const y = Number(data.y) || 0;
    room.cursors.set(socket.userId, { x, y });

    if (dbAvailable) {
      pool.query(
        'INSERT INTO cursors (room_id, user_id, x, y, updated_at) VALUES ($1, $2, $3, $4, NOW()) ' +
          'ON CONFLICT (room_id, user_id) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, updated_at = NOW()',
        [socket.roomId, socket.userId, x, y]
      ).catch((e) => console.error('cursor persist failed:', e.message));
    }

    socket.to(`room-${socket.roomId}`).emit('cursor', {
      userId: socket.userId,
      x,
      y,
      name: room.users.get(socket.userId)?.name || 'Unknown',
      color: room.users.get(socket.userId)?.color || '#FFFFFF'
    });
  });

  socket.on('message', async (data) => {
    if (!socket.roomId || !socket.userId) return;
    const content = (data.content || '').toString().slice(0, 4000);
    if (!content.trim()) return;

    if (dbAvailable) await storeMessage(socket.roomId, socket.userId, content);

    io.to(`room-${socket.roomId}`).emit('message', {
      type: 'message',
      roomId: socket.roomId,
      userId: socket.userId,
      name: socket.userName || 'Unknown',
      content,
      timestamp: Date.now()
    });
  });

  // ---- WebRTC 시그널링 (offer/answer/ICE relay) ----
  // 대상 userId가 지정되면 그 소켓에만, 없으면 방 전체에 전달한다.
  // socket.data에 연결된 userId를 보관해 식별에 사용한다.
  function emitToPeer(roomId, target, event, payload) {
    if (target) {
      for (const [sid, s] of io.sockets.sockets.entries()) {
        if (s.userId === target) {
          s.emit(event, payload);
          return;
        }
      }
    }
    io.to(`room-${roomId}`).emit(event, payload);
  }

  socket.on('webrtc-offer', (data) => {
    if (!socket.roomId) return;
    emitToPeer(socket.roomId, data && data.to, 'webrtc-offer', {
      sdp: data && data.sdp,
      from: socket.userId,
      fromName: socket.userName
    });
  });

  socket.on('webrtc-answer', (data) => {
    if (!socket.roomId) return;
    emitToPeer(socket.roomId, data && data.to, 'webrtc-answer', {
      sdp: data && data.sdp,
      from: socket.userId,
      fromName: socket.userName
    });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    if (!socket.roomId) return;
    emitToPeer(socket.roomId, data && data.to, 'webrtc-ice-candidate', {
      candidate: data && data.candidate,
      from: socket.userId
    });
  });

  // WebRTC 미지원 환경 명시적 처리
  socket.on('webrtc-unsupported', () => {
    socket.emit('webrtc-error', { message: 'WebRTC not supported in this browser' });
  });

  socket.on('leave', () => leaveCurrentRoom(socket));

  socket.on('disconnect', () => {
    const userId = socket.userId;
    const roomId = socket.roomId;
    leaveCurrentRoom(socket);

    if (userId && dbAvailable) {
      pool.query('UPDATE users SET status = $1 WHERE id = $2', ['offline', userId])
        .catch((e) => console.error('status update failed:', e.message));
    }
  });
});

// 방 이탈 공통 처리
function leaveCurrentRoom(socket) {
  if (!socket.roomId) return;
  const roomId = socket.roomId;
  const userId = socket.userId;

  socket.leave(`room-${roomId}`);

  const room = rooms.get(roomId);
  if (room) {
    room.users.delete(userId);
    room.cursors.delete(userId);
    socket.to(`room-${roomId}`).emit('user_left', {
      userId,
      name: socket.userName || 'Unknown',
      users: Array.from(room.users.values()).map((u) => ({ id: u.id, name: u.name, color: u.color }))
    });
    if (room.users.size === 0) rooms.delete(roomId);
  }

  socket.roomId = null;
  socket.userId = null;
  socket.userName = null;
}

// REST API 전체에 일반 레이트리박 적용 (인증 엔드포인트는 더 엄격한 자체 제한을 사용)
app.use('/api', apiRateLimit);

// REST API endpoints
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: Date.now(), 
    connections: io.engine.clientsCount, 
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
      socketio: { connections: io.engine.clientsCount, rooms: io.sockets.adapter.rooms.size }
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

// ===================== 인증 API =====================
// 주의: 이전의 /api/auth/token 은 "이름만으로 토큰 발급"이라 사칭이 가능했다.
// 운영 안전을 위해 회원가입(비밀번호)으로만 토큰을 발급한다.

// 회원가입
app.post('/api/auth/register', loginRateLimit, async (req, res) => {
  const { userId, name, password, email } = req.body || {};

  const idCheck = validateUserId(userId);
  if (!idCheck.ok) return res.status(400).json({ error: idCheck.error, code: 'INVALID_USER_ID' });
  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error, code: 'WEAK_PASSWORD' });
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
    return res.status(400).json({ error: '이름을 1~80자로 입력하세요.', code: 'INVALID_NAME' });
  }

  // 입력 검증을 통과한 뒤 DB 필요 (정책 검증은 DB 없이도 동작해야 함)
  if (!dbAvailable) {
    return res.status(503).json({ error: '데이터베이스를 사용할 수 없습니다.', code: 'DB_UNAVAILABLE' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE id = $1', [idCheck.value]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: '이미 사용 중인 사용자 ID입니다.', code: 'USER_EXISTS' });
    }

    const passwordHash = await hashPassword(password);
    const color = getRandomColor();
    await pool.query(
      `INSERT INTO users (id, name, color, password_hash, is_active, email)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [idCheck.value, name.trim(), color, passwordHash, email || null]
    );

    await recordLoginAttempt(idCheck.value, req, true, 'register');
    const token = await issueSession({ userId: idCheck.value, name: name.trim() }, req);
    res.status(201).json({ token, userId: idCheck.value, name: name.trim() });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: '가입 처리 중 오류가 발생했습니다.' });
  }
});

// 로그인 (비밀번호 검증 필수)
app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const { userId, password } = req.body || {};

  const idCheck = validateUserId(userId);
  if (!idCheck.ok || typeof password !== 'string' || password.length === 0) {
    // 계정 존재 여부를 노출하지 않는 동일한 메시지
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.', code: 'INVALID_CREDENTIALS' });
  }

  if (!dbAvailable) {
    return res.status(503).json({ error: '데이터베이스를 사용할 수 없습니다.', code: 'DB_UNAVAILABLE' });
  }

  try {
    const result = await pool.query(
      'SELECT id, name, color, password_hash, is_active, locked_until, failed_logins FROM users WHERE id = $1',
      [idCheck.value]
    );

    const user = result.rows[0];

    // 잠금 계정 확인
    if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.max(1, Math.ceil((new Date(user.locked_until) - Date.now()) / 60000));
      await recordLoginAttempt(idCheck.value, req, false, 'locked');
      return res.status(423).json({ error: `계정이 잠겼습니다. ${mins}분 후 다시 시도하세요.`, code: 'ACCOUNT_LOCKED' });
    }

    // 계정이 없으면 더미 해시 검증으로 응답 시간을 맞춘다
    if (!user) {
      await dummyVerify();
      await recordLoginAttempt(idCheck.value, req, false, 'no_such_user');
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.', code: 'INVALID_CREDENTIALS' });
    }

    // 비밀번호가 설정되지 않은 계정(레거시 데이터)은 로그인 불가
    if (!user.password_hash) {
      await recordLoginAttempt(idCheck.value, req, false, 'no_password_set');
      return res.status(403).json({ error: '비밀번호가 설정되지 않은 계정입니다. 관리자에게 문의하세요.', code: 'NO_PASSWORD' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      const failed = (user.failed_logins || 0) + 1;
      // 5회 연속 실패 시 15분 잠금
      if (failed >= 5) {
        await pool.query(
          'UPDATE users SET failed_logins = $1, locked_until = NOW() + INTERVAL \'15 minutes\' WHERE id = $2',
          [failed, user.id]
        );
        await recordLoginAttempt(user.id, req, false, 'too_many_failures');
        return res.status(423).json({ error: '로그인 실패가 5회 누적되어 15분간 잠겼습니다.', code: 'ACCOUNT_LOCKED' });
      }
      await pool.query('UPDATE users SET failed_logins = $1 WHERE id = $2', [failed, user.id]);
      await recordLoginAttempt(user.id, req, false, 'bad_password');
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.', code: 'INVALID_CREDENTIALS' });
    }

    if (user.is_active === false) {
      await recordLoginAttempt(user.id, req, false, 'inactive');
      return res.status(403).json({ error: '비활성화된 계정입니다. 관리자에게 문의하세요.', code: 'ACCOUNT_DISABLED' });
    }

    // 성공: 실패 카운트 초기화 + 세션 발급
    await pool.query(
      'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW(), status = $1 WHERE id = $2',
      ['online', user.id]
    );
    await recordLoginAttempt(user.id, req, true, 'login');

    const token = await issueSession({ userId: user.id, name: user.name }, req);
    res.json({ token, userId: user.id, name: user.name, color: user.color });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
  }
});

// 로그아웃 (현재 세션 폐기)
app.post('/api/auth/logout', requireAuth, requireDb, async (req, res) => {
  try {
    const token = extractToken(req);
    const decoded = verifyToken(token);
    if (decoded && decoded.jti) {
      await pool.query(
        'UPDATE auth_sessions SET revoked_at = NOW() WHERE jti = $1 AND revoked_at IS NULL',
        [decoded.jti]
      );
    }
    if (req.user) {
      await pool.query('UPDATE users SET status = $1 WHERE id = $2', ['offline', req.user.id]).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Logout error:', e);
    res.status(500).json({ error: '로그아웃 처리 중 오류가 발생했습니다.' });
  }
});

// 비밀번호 변경 (현재 비밀번호 필요)
app.post('/api/auth/change-password', requireAuth, requireDb, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const pwCheck = validatePassword(newPassword);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error, code: 'WEAK_PASSWORD' });

  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user || !user.password_hash) {
      return res.status(403).json({ error: '비밀번호가 설정되지 않은 계정입니다.', code: 'NO_PASSWORD' });
    }
    const valid = await verifyPassword(currentPassword || '', user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '현재 비밀번호가 올바르지 않습니다.', code: 'INVALID_CREDENTIALS' });
    }
    const newHash = await hashPassword(newPassword);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);
    // 비밀번호 변경 시 기존 세션 모두 폐기
    await pool.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]);
    res.json({ success: true, message: '비밀번호가 변경되었습니다. 다시 로그인하세요.' });
  } catch (e) {
    console.error('Change password error:', e);
    res.status(500).json({ error: '비밀번호 변경 중 오류가 발생했습니다.' });
  }
});

// 현재 사용자 조회 (requireAuth로 세션까지 검증하므로 로그아웃 즉시 401)
app.get('/api/auth/me', requireAuth, requireDb, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, color, email, status, last_login_at, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'USER_NOT_FOUND' });
    }
    res.json({ user: result.rows[0] });
  } catch (e) {
    console.error('/me error:', e);
    res.status(500).json({ error: '사용자 정보를 조회하지 못했습니다.' });
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
// googleapis 패키지가 매우 크므로 기동 시점 로딩을 피하고 실제 사용 시 1회만 로딩한다.
// (일부 마운트 환경에서는 require가 수십 초 걸려 서버 기동을 전부 지연시킨다)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8081/api/auth/google/callback';
const googleEnabled = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

let _google = null;
let _oauth2Client = null;

function googleApi() {
  if (!_google) _google = require('googleapis').google;
  return _google;
}

function oauthClient() {
  if (!_oauth2Client) {
    _oauth2Client = googleApi().auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );
  }
  return _oauth2Client;
}

// OAuth state HMAC 서명/검증 (10분 만료)
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function signOAuthState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + OAUTH_STATE_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyOAuthState(state) {
  if (typeof state !== 'string' || !state.includes('.')) return null;
  const [body, sig] = state.split('.');
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (_) {
    return null;
  }
}

// OAuth 미설정 상태에서는 명확히 503으로 알린다 (무음 실패 방지)
app.use('/api/auth/google', (req, res, next) => {
  if (!googleEnabled) {
    return res.status(503).json({
      error: 'Google OAuth not configured',
      code: 'GOOGLE_OAUTH_DISABLED',
      hint: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 환경변수를 설정하세요.'
    });
  }
  next();
});
app.use('/api/calendar', (req, res, next) => {
  if (!googleEnabled) {
    return res.status(503).json({
      error: 'Google Calendar integration not configured',
      code: 'GOOGLE_OAUTH_DISABLED'
    });
  }
  next();
});

// Google OAuth2 URL 생성
app.get('/api/auth/google/url', requireAuth, (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events'
  ];
  // state는 서명해야 한다. 평문 JSON을 쓰면 사용자가 다른 userId로 위조해
  // OAuth 토큰이 다른 계정에 연결될 수 있다.
  const stateToken = signOAuthState({ userId: req.user.id });
  const url = oauthClient().generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    state: stateToken,
  });
  res.json({ url });
});

// Google OAuth2 콜백 처리
app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Authorization code missing');

  try {
    const { tokens } = await oauthClient().getToken(code);
    oauthClient().setCredentials(tokens);

    // 상태 복원 및 사용자 연결
    const stateData = verifyOAuthState(state);
    if (!stateData || !stateData.userId) {
      return res.status(400).send('Invalid OAuth state');
    }
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
    oauthClient().setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry
    });

    const calendar = googleApi().calendar({ version: 'v3', auth: oauthClient() });

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
    oauthClient().setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry
    });

    const calendar = googleApi().calendar({ version: 'v3', auth: oauthClient() });

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
        oauthClient().setCredentials(tokens);

        const calendar = googleApi().calendar({ version: 'v3', auth: oauthClient() });
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

// 조직 데이터는 인증 필수이며 DB가 반드시 필요하다
app.use('/api/organizations', requireAuth, requireDb);

// 조직 생성
app.post('/api/organizations', requireAuth, requireDb, async (req, res) => {
  try {
    const { name, slug, description } = req.body || {};
    const userId = req.user.id; // 소유자는 토큰의 사용자 (스푸핑 방지)

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: '조직 이름을 입력하세요.', code: 'NAME_REQUIRED' });
    }
    if (name.length > 120) {
      return res.status(400).json({ error: '조직 이름이 너무 깁니다.', code: 'NAME_TOO_LONG' });
    }
    const cleanSlug = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(cleanSlug)) {
      return res.status(400).json({
        error: '슬러그는 영문 소문자/숫자/하이픈 3~50자로 지정하세요.',
        code: 'INVALID_SLUG',
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 동시 생성 경쟁 조건까지 막기 위해 DB unique 위반을 409로 매핑
      const orgResult = await client.query(
        `INSERT INTO organizations (id, name, slug, description)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [uuidv4(), name.trim(), cleanSlug, description || '']
      );
      const org = orgResult.rows[0];

      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [org.id, userId]
      );
      await client.query(
        `INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'create', 'organization', $3)`,
        [org.id, userId, org.id]
      );

      await client.query('COMMIT');
      res.status(201).json({ organization: org });
    } catch (e) {
      await client.query('ROLLBACK');
      // 23505 = unique_violation
      if (e.code === '23505') {
        return res.status(409).json({ error: '이미 사용 중인 슬러그입니다.', code: 'SLUG_TAKEN' });
      }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Create organization error:', e);
    res.status(500).json({ error: '조직 생성에 실패했습니다.' });
  }
});

app.get('/api/organizations', async (req, res) => {
  try {
    const userId = req.user.id;
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
    const userId = req.user.id;

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
    const userId = req.user.id;
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
app.post('/api/organizations/:orgId/invites', requireAuth, requireDb, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { email, role } = req.body || {};
    const userId = req.user.id; // 토큰에서만取得 (스푸핑 방지)

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: '이메일을 입력하세요.', code: 'EMAIL_REQUIRED' });
    }
    const allowedRoles = ['admin', 'member', 'viewer'];
    const inviteRole = allowedRoles.includes(role) ? role : 'member';

    const roleResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    const userRole = roleResult.rows[0] && roleResult.rows[0].role;
    if (!userRole || !['owner', 'admin'].includes(userRole)) {
      return res.status(403).json({ error: '초대 권한이 없습니다.', code: 'FORBIDDEN' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7일

    await pool.query(
      `INSERT INTO organization_invites (organization_id, email, role, token, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, email.trim(), inviteRole, token, userId, expiresAt]
    );

    await pool.query(
      `INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'invite', 'organization', $3, $4)`,
      [orgId, userId, orgId, JSON.stringify({ email, role: inviteRole })]
    );

    const base = process.env.FRONTEND_URL || '';
    res.json({
      invite: {
        email,
        role: inviteRole,
        token,
        expiresAt,
        invitePath: '/?invite=' + token,
        inviteUrl: base ? base + '/?invite=' + token : '',
      },
    });
  } catch (e) {
    console.error('Create invite error:', e);
    res.status(500).json({ error: '초대를 만들지 못했습니다.' });
  }
});

// 초대 수락
// 초대 수락
// 주의: 인증 없이 "아무 userId로나" 계정을 만들 수 있으면 초대 우회로가 되므로
// 반드시 requireAuth를 거치고, 토큰의 userId만 사용한다.
app.post('/api/organizations/invites/:token/accept', requireAuth, requireDb, async (req, res) => {
  try {
    const { token } = req.params;

    const inviteResult = await pool.query(
      `SELECT * FROM organization_invites
       WHERE token = $1 AND expires_at > NOW() AND accepted_at IS NULL`,
      [token]
    );
    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: '유효하지 않거나 만료된 초대입니다.', code: 'INVALID_INVITE' });
    }
    const invite = inviteResult.rows[0];
    const userId = req.user.id;

    // 이미 다른 멤버이면 충돌 방지
    const existing = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [invite.organization_id, userId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: '이미 이 조직의 멤버입니다.', code: 'ALREADY_MEMBER' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $2, $3)`,
        [invite.organization_id, userId, invite.role]
      );
      await client.query(
        'UPDATE organization_invites SET accepted_at = NOW() WHERE token = $1',
        [token]
      );
      await client.query(
        `INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'accept_invite', 'organization', $3)`,
        [invite.organization_id, userId, invite.organization_id]
      );

      await client.query('COMMIT');
      res.json({ success: true, organizationId: invite.organization_id, role: invite.role });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Accept invite error:', e);
    res.status(500).json({ error: '초대 수락 처리에 실패했습니다.' });
  }
});

app.patch('/api/organizations/:orgId/members/:memberId', requireAuth, requireDb, async (req, res) => {
  try {
    const { orgId, memberId } = req.params;
    const { role } = req.body || {};
    const userId = req.user.id; // 토큰에서만 취득

    const VALID = ['owner', 'admin', 'member', 'viewer'];
    if (!role || !VALID.includes(role)) {
      return res.status(400).json({ error: '유효하지 않은 역할입니다.', code: 'INVALID_ROLE' });
    }

    const requesterRoleResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    const requesterRole = requesterRoleResult.rows[0] && requesterRoleResult.rows[0].role;
    if (!requesterRole || !['owner', 'admin'].includes(requesterRole)) {
      return res.status(403).json({ error: '권한이 없습니다.', code: 'FORBIDDEN' });
    }

    const targetResult = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, memberId]
    );
    if (targetResult.rows.length === 0) {
      return res.status(404).json({ error: '멤버를 찾을 수 없습니다.', code: 'MEMBER_NOT_FOUND' });
    }
    const targetRole = targetResult.rows[0].role;

    // 계정 보호: requesterRole이 DB 기준이므로 자기 강등 후 복구 불가 문제도 함께 다룬다.
    // - admin은 member/viewer만 관리할 수 있다
    // - admin/owner 지정은 owner만 가능하다
    if (requesterRole !== 'owner' && ['admin', 'owner'].includes(targetRole)) {
      return res.status(403).json({ error: 'admin/owner 멤버는 소유자만 변경할 수 있습니다.', code: 'FORBIDDEN' });
    }
    if (requesterRole !== 'owner' && ['admin', 'owner'].includes(role)) {
      return res.status(403).json({ error: 'admin/owner 역할은 소유자만 부여할 수 있습니다.', code: 'FORBIDDEN' });
    }

    // 마지막 owner를 제거/강등해 조직에 관리자가 없어지는 것을 방지한다
    if (targetRole === 'owner' && role !== 'owner') {
      const owners = await pool.query(
        "SELECT COUNT(*) AS c FROM organization_members WHERE organization_id = $1 AND role = 'owner'",
        [orgId]
      );
      if (owners.rows[0].c <= 1) {
        return res.status(409).json({
          error: '조직에는 최소 한 명의 소유자가 있어야 합니다.',
          code: 'LAST_OWNER',
        });
      }
    }

    await pool.query(
      'UPDATE organization_members SET role = $1 WHERE organization_id = $2 AND user_id = $3',
      [role, orgId, memberId]
    );

    await pool.query(
      `INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'update_role', 'member', $3, $4)`,
      [orgId, userId, memberId, JSON.stringify({ oldRole: targetRole, newRole: role })]
    );

    res.json({ success: true, role });
  } catch (e) {
    console.error('Update member role error:', e);
    res.status(500).json({ error: '역할 변경에 실패했습니다.' });
  }
});

app.delete('/api/organizations/:orgId/members/:memberId', async (req, res) => {
  try {
    const { orgId, memberId } = req.params;
    const userId = req.user.id;
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
    const userId = req.user.id;
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
    // 부트 시점에 테이블이 아직 없거나 DB가 준비되지 않은 경우가 있으므로
    // 치명 오류로 취급하지 않고 경고만 남긴다.
    console.warn('Role initialization skipped:', e.message);
  }
}

// 기본 시스템 역할은 bootstrapPromise 체인에서 초기화된다
// (여기서 별도로 호출하면 테이블 생성 전에 실행되어 실패한다)

// ============================================
// 푸시 알림 API
// ============================================

// 푸시 API는 인증 필수 + DB 필요 + VAPID 설정 확인 순서로 검증한다
// VAPID 공개키 제공 (인증 불필요 - 공개키이므로 노출해도 안전)
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!isPushEnabled()) {
    return res.status(503).json({ error: 'Web Push not configured', code: 'PUSH_DISABLED' });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.use('/api/push', requireAuth, requireDb, (req, res, next) => {
  if (!isPushEnabled()) {
    return res.status(503).json({ error: 'Web Push not configured', code: 'PUSH_DISABLED' });
  }
  next();
});

// 푸시 구독 저장
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { userId, subscription } = req.body;
    if (!userId || !subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'userId and subscription required' });
    }

    // 스키마는 setupDatabase에서 보장된다.
    // 인증된 사용자라 해도 users 행이 없을 수 있으므로(토큰만 발급된 경우) 보장 삽입한다.
    const keys = subscription.keys || {};
    await pool.query(
      'INSERT INTO users (id, name, color) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [userId, req.user && req.user.name ? req.user.name : userId, getRandomColor()]
    );
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
// web-push도 실제 발송 시점에만 로딩해 기동을 빠르게 유지한다
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@tev1.local';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
let pushEnabled = false;

// 푸시 가드/라우트에서 참조하는 상태 접근자 (선언 순서 무관)
function isPushEnabled() {
  return pushEnabled === true;
}

function webpushApi() {
  return require('web-push');
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpushApi().setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushEnabled = true;
    console.log('Web Push enabled');
  } catch (e) {
    console.warn('Web Push disabled (invalid VAPID keys):', e.message);
  }
} else {
  console.warn('Web Push disabled (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set)');
}

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
        await webpushApi().sendNotification(pushSubscription, payload);
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
        await webpushApi().sendNotification(pushSubscription, payload);
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

// 분석 데이터는 조직 구성원 전용이며 DB가 반드시 필요하다
app.use('/api/analytics', requireAuth, requireDb);

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

    // 방별(회의별) 소요시간을 부분집계로 구한 뒤 평균을 낸다.
    // AVG(MAX()-MIN())처럼 집계 중첩은 PostgreSQL에서 허용되지 않는다.
    const avgDuration = await pool.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (span.last_at - span.first_at)) / 60) AS avg_minutes
      FROM (
        SELECT m.room_id,
               MIN(m.created_at) AS first_at,
               MAX(m.created_at) AS last_at
        FROM messages m
        JOIN rooms r ON m.room_id = r.id
        JOIN room_organizations ro ON r.id = ro.room_id
        WHERE ro.organization_id = $1 AND r.created_at BETWEEN $2 AND $3
        GROUP BY m.room_id
      ) AS span
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

    // 집계 중첩을 피하기 위해 회의/메시지 집계와 소요시간 계산을 분리한다.
    const meetings = await pool.query(`
      SELECT
        COUNT(DISTINCT r.id) AS meetings_attended,
        COUNT(DISTINCT m.id) AS messages_sent,
        COUNT(DISTINCT CASE WHEN m.created_at::date = CURRENT_DATE THEN r.id END) AS meetings_today
      FROM rooms r
      JOIN room_organizations ro ON r.id = ro.room_id
      LEFT JOIN messages m ON r.id = m.room_id AND m.user_id = $1
      JOIN room_users ru ON r.id = ru.room_id
      WHERE ro.organization_id = $2 AND ru.user_id = $1 AND r.created_at BETWEEN $3 AND $4
    `, [userId, orgId, start, end]);

    const userSpan = await pool.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (span.last_at - span.first_at)) / 60) AS avg_minutes
      FROM (
        SELECT m.room_id, MIN(m.created_at) AS first_at, MAX(m.created_at) AS last_at
        FROM messages m
        JOIN rooms r ON m.room_id = r.id
        JOIN room_organizations ro ON r.id = ro.room_id
        JOIN room_users ru ON r.id = ru.room_id
        WHERE m.user_id = $1 AND ro.organization_id = $2 AND ru.user_id = $1
          AND r.created_at BETWEEN $3 AND $4
        GROUP BY m.room_id
      ) AS span
    `, [userId, orgId, start, end]);
    const avgMinutes = userSpan.rows[0] ? userSpan.rows[0].avg_minutes : null;

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
      avgMeetingDurationMinutes: Math.round(avgMinutes || 0),
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
// Prometheus 스크랩용. 기본은 인증 없음(내부망 전제)이나 METRICS_TOKEN을 두면
// Bearer 인증을 요구하며, 그 밖의 곳에서는 404로 숨긴다.
const METRICS_TOKEN = process.env.METRICS_TOKEN || '';

app.get('/metrics', async (req, res) => {
  if (METRICS_TOKEN) {
    const provided = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const a = Buffer.from(provided);
    const b = Buffer.from(METRICS_TOKEN);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).type('text/plain').send('# unauthorized\n');
    }
  } else if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PUBLIC_METRICS !== 'true') {
    // 운영 환경에서 토큰도 공개도 모두 미설정되면 외부 노출을 막는다
    return res.status(404).type('text/plain').send('not found\n');
  }
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
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, starting graceful shutdown...`);

  // Disconnect Socket.IO clients (ws 레거시 서버는 더 이상 사용하지 않음)
  io.sockets.sockets.forEach((socket) => {
    socket.emit('server_shutdown', { reason: signal });
    socket.disconnect(true);
  });

  const forceExit = setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
  forceExit.unref();

  // Close Socket.IO + HTTP server
  await new Promise((resolve) => {
    io.close(() => {
      server.close(() => resolve());
    });
  });
  console.log('HTTP/Socket.IO server closed');

  // Close PostgreSQL pool
  try {
    await pool.end();
    console.log('PostgreSQL pool closed');
  } catch (e) {
    console.warn('PostgreSQL pool close error:', e.message);
  }

  // Close Redis only when connected (미연결 시 quit이 멈춘다)
  if (redisAvailable) {
    try {
      await redis.quit();
      console.log('Redis connection closed');
    } catch (e) {
      console.warn('Redis close error:', e.message);
    }
  }

  clearTimeout(forceExit);
  process.exit(0);
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
const bootStartedAt = Date.now();
server.listen(PORT, () => {
  console.log(`Server ready in ${Date.now() - bootStartedAt}ms on port ${PORT}`);
  console.log(`REST API:      http://localhost:${PORT}`);
  console.log(`Socket.IO:     http://localhost:${PORT} (ws://localhost:${PORT})`);
  console.log(`Health:        http://localhost:${PORT}/health`);
  console.log(`Health detail: http://localhost:${PORT}/health/detailed`);
  console.log(`Metrics:       http://localhost:${PORT}/metrics`);
  console.log(`Dependencies:  database=${dbAvailable ? 'connected' : 'unavailable'}, redis=${redisAvailable ? 'connected' : 'unavailable'}`);
  console.log(`Google OAuth:  ${googleEnabled ? 'enabled' : 'disabled (set GOOGLE_CLIENT_ID/SECRET)'}`);
  console.log(`Web Push:      ${pushEnabled ? 'enabled' : 'disabled (set VAPID keys)'}`);
});

// 부트 준비 신호: 스키마 생성(및 기본 역할 시드)이 끝나면 resolve된다.
// 테스트나 상위 코드가 이 프라미스를 await하면 스키마 없이 쿼리를 보내지 않는다.
module.exports = { app, server, io, pool, redis, ready: bootstrapPromise };