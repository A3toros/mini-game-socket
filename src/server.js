const express = require('express');
const { createServer } = require('http');
const WebSocket = require('ws');
const { neon } = require('@neondatabase/serverless');
require('dotenv').config();

const gameManager = require('./gameManager');
const queueManager = require('./queueManager');
const matchManager = require('./matchManager');

const app = express();
const server = createServer(app);
const port = process.env.PORT || 10000;

// WebSocket server at /ws
const wss = new WebSocket.Server({ server, path: '/ws' });

// Database connection
const sql = neon(process.env.NEON_DATABASE_URL);

// HTTP routes for health checks
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'mini-games-websocket' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Heartbeat function for connection health
function heartbeat() {
  this.isAlive = true;
}

// WebSocket connection handler
wss.on('connection', function connection(ws, req) {
  ws.isAlive = true;
  ws.on('error', console.error);
  ws.on('pong', heartbeat);

  // Parse query parameters for session code
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionCode = url.searchParams.get('session');
  const userId = url.searchParams.get('userId');
  const userRole = url.searchParams.get('role'); // 'teacher' or 'student'

  if (!sessionCode || !userId) {
    ws.close(1008, 'Missing session code or user ID');
    return;
  }

  // Store connection metadata
  ws.sessionCode = sessionCode;
  ws.userId = userId;
  ws.userRole = userRole;
  ws.matchId = null;
  ws.playerId = null;

  console.log(`Client connected: ${userId} (${userRole}) to session ${sessionCode}`);

  // Handle incoming messages
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      await handleMessage(ws, data);
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  // Handle disconnection
  ws.on('close', async (code, reason) => {
    console.log(`Client disconnected: ${ws.userId} (code: ${code})`);
    await handleDisconnection(ws);
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    sessionCode: sessionCode,
    userId: userId
  }));
});

  // Message handler
  async function handleMessage(ws, data) {
    const { type, payload } = data;
    // Log all messages for debugging (except ping/pong)
    if (type !== 'ping' && type !== 'pong') {
      console.log('[Server] Received message:', { type, userId: ws.userId, sessionCode: ws.sessionCode, payload: type === 'spell-hit' ? { matchId: payload?.matchId, spellId: payload?.spellId, hitPlayerId: payload?.hitPlayerId } : '...' });
    }

  switch (type) {
    case 'join-session':
      await gameManager.joinSession(ws, payload);
      break;

    case 'card-answered':
      await gameManager.handleCardAnswer(ws, payload);
      break;

    case 'enter-queue':
      await queueManager.enterQueue(ws, payload);
      break;

    case 'player-move':
      await matchManager.handlePlayerMove(ws, payload);
      break;

    case 'spell-cast':
      console.log('[Server] ========== RECEIVED spell-cast MESSAGE ==========');
      console.log('[Server] spell-cast payload:', payload);
      console.log('[Server] ws.playerId:', ws.playerId);
      console.log('[Server] ws.matchId:', ws.matchId);
      try {
        await matchManager.handleSpellCast(ws, payload);
        console.log('[Server] handleSpellCast completed successfully');
      } catch (error) {
        console.error('[Server] ========== ERROR in handleSpellCast ==========');
        console.error('[Server] Error:', error);
        console.error('[Server] Stack:', error.stack);
      }
      break;

    case 'round-ready':
      await matchManager.handleRoundReady(ws, payload);
      break;

    case 'character-selected':
      await gameManager.handleCharacterSelection(ws, payload);
      break;

    case 'join-lobby':
      await gameManager.handleJoinLobby(ws, payload);
      break;

    case 'start-game':
      await gameManager.handleStartGame(ws, payload);
      break;

    case 'finish-game':
      await gameManager.handleFinishGame(ws, payload);
      break;

    case 'spell-hit':
      await matchManager.handleSpellHit(payload.matchId, payload.spellId, payload.hitPlayerId);
      break;

    case 'ping':
      // Handle ping/pong for connection health
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      ws.send(JSON.stringify({
        type: 'error',
        message: `Unknown message type: ${type}`
      }));
  }
}

// Disconnection handler
async function handleDisconnection(ws) {
  // Remove from queue if in queue
  if (ws.userId) {
    await queueManager.removeFromQueue(ws.userId);
  }

  // Handle match disconnection
  if (ws.matchId) {
    await matchManager.handlePlayerDisconnect(ws.matchId, ws.playerId);
  }

  // Remove from game session
  if (ws.sessionCode) {
    await gameManager.handleDisconnect(ws.sessionCode, ws.userId);
  }
}

// Ping all connected clients every 30 seconds
const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    // Close connections that failed to "pong" the previous ping
    if (ws.isAlive === false) {
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Cleanup on server shutdown
wss.on('close', function close() {
  clearInterval(interval);
});

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  
  // Notify all clients
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'server-shutdown',
        message: 'Server is shutting down. Please reconnect.'
      }));
      ws.close();
    }
  });

  // Close server
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });

  // Force close after 30 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
});

server.listen(port, () => {
  console.log(`WebSocket server listening on port ${port}`);
});

