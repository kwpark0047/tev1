const WebSocket = require('ws');
const { app, server, wss } = require('../src/server');
const jwt = require('jsonwebtoken');

const PORT = 8082; // Test port
const JWT_SECRET = 'test-secret';

// Test utilities
function createWs(url = 'ws://localhost:8082') {
  return new WebSocket(url);
}

function sendMessage(ws, message) {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      ws.on('open', () => {
        ws.send(JSON.stringify(message));
        resolve();
      });
    } else {
      ws.send(JSON.stringify(message));
      resolve();
    }
  });
}

function waitForMessage(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === type) {
          clearTimeout(timeoutId);
          resolve(msg);
        }
      } catch (e) {}
    });
  });
}

describe('WebSocket Server', () => {
  let testServer;
  let testWss;

  beforeAll((done) => {
    // Start test server on different port
    const testApp = require('../src/server').app;
    const testServer = require('http').createServer(require('../src/server').app);
    const testWss = new require('ws').WebSocket.Server({ server: testServer });
    
    // Copy WebSocket handlers
    // (In real test, we'd import the server module properly)
    testServer.listen(8082, done);
  });

  afterAll((done) => {
    // Clean up
    done();
  });

  describe('WebSocket Connection', () => {
    let ws;

    beforeEach((done) => {
      ws = new WebSocket('ws://localhost:8082');
      ws.on('open', done);
    });

    afterEach(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    test('should connect successfully', () => {
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    test('should reject invalid auth', (done) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'auth_result') {
          expect(msg.success).toBe(false);
          done();
        }
      });
      
      ws.send(JSON.stringify({ type: 'auth', token: 'invalid-token' }));
    });
  });

  describe('Authentication', () => {
    let ws;

    beforeEach((done) => {
      ws = new WebSocket('ws://localhost:8082');
      ws.on('open', done);
    });

    afterEach(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    test('should accept valid JWT token', (done) => {
      const token = jwt.sign({ userId: 'test-user', name: 'Test User' }, 'test-secret');
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'auth_result') {
          expect(msg.success).toBe(true);
          expect(msg.userId).toBe('test-user');
          expect(msg.name).toBe('Test User');
          done();
        }
      });
      
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: jwt.sign({ userId: 'test-user', name: 'Test User' }, 'test-secret') }));
      });
    });
  });

  describe('Room Operations', () => {
    let ws;

    beforeEach(async () => {
      ws = new WebSocket('ws://localhost:8082');
      await new Promise(r => ws.on('open', r));
      
      // Authenticate first
      const token = jwt.sign({ userId: 'test-user', name: 'Test User' }, 'test-secret');
      ws.send(JSON.stringify({ type: 'auth', token }));
      await new Promise(r => setTimeout(r, 100));
    });

    afterEach(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    test('should join room', (done) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'joined') {
          expect(msg.userId).toBeDefined();
          expect(msg.name).toBe('Test User');
          expect(msg.users).toHaveLength(1);
          done();
        }
      });
      
      ws.send(JSON.stringify({ type: 'join', roomId: 'test-room', name: 'Test User' }));
    });

    test('should broadcast cursor to others', (done) => {
      // Need two connections for this test
      const ws2 = new WebSocket('ws://localhost:8082');
      ws2.on('open', () => {
        ws2.send(JSON.stringify({ type: 'auth', token: jwt.sign({ userId: 'user2', name: 'User2' }, 'test-secret') }));
      });

      setTimeout(() => {
        ws2.send(JSON.stringify({ type: 'join', roomId: 'test-room', name: 'User2' }));
        
        setTimeout(() => {
          ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.type === 'cursor') {
              expect(msg.x).toBe(100);
              expect(msg.y).toBe(200);
              expect(msg.userId).toBeDefined();
              ws2.close();
              done();
            }
          });
          
          ws.send(JSON.stringify({ type: 'cursor', x: 100, y: 200 }));
        }, 200);
      }, 200);
    }, 10000);
  });

  describe('Health Check', () => {
    test('should return health status', async () => {
      const response = await fetch('http://localhost:8082/health');
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.connections).toBeDefined();
    });
  });
});