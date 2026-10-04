#!/bin/bash
# Quick test script for WebSocket server

set -e

echo "=== Starting WebSocket Server Test ==="

# Start server in background
echo "Starting server on port 8082..."
node src/server.js &
SERVER_PID=$!

# Wait for server to start
sleep 3

echo "Server started (PID: $SERVER_PID)"

# Test health endpoint
echo "Testing health endpoint..."
curl -s http://localhost:8082/health | jq .

# Test WebSocket connection with wscat if available
if command -v wscat &> /dev/null; then
    echo "Testing WebSocket connection..."
    echo '{"type":"auth","token":"invalid"}' | timeout 5 wscat -c ws://localhost:8082 -x '{"type":"auth","token":"invalid"}' || true
else
    echo "wscat not available, skipping WebSocket test"
fi

# Test REST API
echo "Testing REST API..."
curl -s http://localhost:8082/health | jq .
curl -s -X POST http://localhost:8082/api/auth/token -H "Content-Type: application/json" -d '{"userId":"test","name":"Test"}' | jq .

# Cleanup
kill $SERVER_PID
echo "Test completed!"