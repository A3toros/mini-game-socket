const matchManager = require('./matchManager');
const gameManager = require('./gameManager');
const WebSocket = require('ws');

// Store queue in memory (per session)
const queues = new Map();

class QueueManager {
  // Student enters matchmaking queue
  async enterQueue(ws, payload) {
    const { sessionCode, studentId } = payload;
    
    if (!queues.has(sessionCode)) {
      queues.set(sessionCode, []);
    }

    const queue = queues.get(sessionCode);
    
    // Check if already in queue
    if (queue.find(p => p.studentId === studentId)) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Already in queue'
      }));
      return;
    }

    // Get player data from session
    const session = gameManager.getSession(sessionCode);
    if (!session) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Session not found'
      }));
      return;
    }

    const player = session.players.get(studentId);
    if (!player) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Player not found in session'
      }));
      return;
    }

    // Check if player is eliminated
    if (player.eliminated || player.hp <= 0) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'You have been eliminated from the tournament'
      }));
      return;
    }

    // Clear previous match reference
    player.matchId = null;

    // Mark player as in queue
    player.inQueue = true;

    // Add to queue
    queue.push({
      studentId,
      ws,
      sessionCode,
      damage: player.damage,
      hp: player.hp,
      selectedCharacter: player.selectedCharacter,
      studentNickname: player.studentNickname,
      enteredAt: Date.now()
    });

    ws.send(JSON.stringify({
      type: 'queue-joined',
      position: queue.length
    }));

    // Try to match if 2+ players
    if (queue.length >= 2) {
      await this.tryMatch(sessionCode);
    }
  }

  // Try to match players
  async tryMatch(sessionCode) {
    const queue = queues.get(sessionCode);
    if (!queue || queue.length < 2) return;

    // Get first two players (FIFO)
    const player1 = queue.shift();
    const player2 = queue.shift();

    // Mark players as not in queue
    const session = gameManager.getSession(sessionCode);
    if (session) {
      const p1 = session.players.get(player1.studentId);
      const p2 = session.players.get(player2.studentId);
      if (p1) p1.inQueue = false;
      if (p2) p2.inQueue = false;
    }

    // Create match
    const matchId = await matchManager.createMatch(
      sessionCode,
      player1,
      player2
    );

    // Notify both players
    if (player1.ws.readyState === WebSocket.OPEN) {
      player1.ws.send(JSON.stringify({
        type: 'match-found',
        matchId,
        opponentId: player2.studentId,
        opponentNickname: player2.studentNickname,
        opponentCharacter: player2.selectedCharacter,
        opponentDamage: player2.damage,
        isPlayer1: true
      }));
    }

    if (player2.ws.readyState === WebSocket.OPEN) {
      player2.ws.send(JSON.stringify({
        type: 'match-found',
        matchId,
        opponentId: player1.studentId,
        opponentNickname: player1.studentNickname,
        opponentCharacter: player1.selectedCharacter,
        opponentDamage: player1.damage,
        isPlayer2: true
      }));
    }

    // Try to match more players if queue has 2+ remaining
    if (queue.length >= 2) {
      setTimeout(() => this.tryMatch(sessionCode), 100);
    }
  }

  // Remove from queue
  async removeFromQueue(studentId) {
    for (const [sessionCode, queue] of queues.entries()) {
      const index = queue.findIndex(p => p.studentId === studentId);
      if (index !== -1) {
        const player = queue[index];
        queue.splice(index, 1);
        
        // Mark player as not in queue
        const session = gameManager.getSession(sessionCode);
        if (session) {
          const p = session.players.get(studentId);
          if (p) p.inQueue = false;
        }
        
        // Notify player
        if (player && player.ws.readyState === WebSocket.OPEN) {
          player.ws.send(JSON.stringify({
            type: 'queue-left'
          }));
        }
        break;
      }
    }
  }

  // Get queue position
  getQueuePosition(sessionCode, studentId) {
    const queue = queues.get(sessionCode);
    if (!queue) return null;
    
    const index = queue.findIndex(p => p.studentId === studentId);
    return index === -1 ? null : index + 1;
  }
}

module.exports = new QueueManager();

