const { neon } = require('@neondatabase/serverless');
const WebSocket = require('ws');

const sql = neon(process.env.NEON_DATABASE_URL);

// Store active sessions in memory (can be moved to Redis for multi-instance)
const activeSessions = new Map();

// Helper function to shuffle array (Fisher-Yates algorithm)
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Helper function to get random questions
function getRandomQuestions(questions, count = 3) {
  if (questions.length <= count) {
    return shuffleArray(questions);
  }
  const shuffled = shuffleArray(questions);
  return shuffled.slice(0, count);
}

class GameManager {
  // Teacher creates a session
  async createSession(gameId, teacherId) {
    // Generate unique session code
    const sessionCode = this.generateSessionCode();
    
    // Create session in database
    const result = await sql`
      INSERT INTO mini_game_sessions (game_id, teacher_id, session_code, status)
      VALUES (${gameId}, ${teacherId}, ${sessionCode}, 'waiting')
      RETURNING id, session_code, created_at
    `;
    
    const session = result[0];
    activeSessions.set(sessionCode, {
      id: session.id,
      gameId,
      teacherId,
      status: 'waiting',
      gameStarted: false, // Flag to track if teacher has started the game
      players: new Map(),
      teacherWs: null, // WebSocket for the teacher
      questions: [],
      createdAt: session.created_at
    });
    
    return sessionCode;
  }

  // Student joins session
  async joinSession(ws, payload) {
    const { sessionCode, studentId, studentName, studentNickname } = payload;
    
    const session = activeSessions.get(sessionCode);
    if (!session) {
      // Try to load from database
      const dbSession = await sql`
        SELECT id, game_id, teacher_id, status
        FROM mini_game_sessions
        WHERE session_code = ${sessionCode}
          AND status IN ('waiting', 'active')
      `;
      
      if (dbSession.length === 0) {
        // Check if session exists but with different status
        const anySession = await sql`
          SELECT id, status, session_code
          FROM mini_game_sessions
          WHERE session_code = ${sessionCode}
        `;
        
        if (anySession.length > 0) {
          const session = anySession[0];
          ws.send(JSON.stringify({
            type: 'error',
            message: `Session found but status is '${session.status}'. Only 'waiting' or 'active' sessions can be joined.`
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            message: `Session '${sessionCode}' not found. It may have been deleted or the code is incorrect.`
          }));
        }
        return;
      }
      
      // Recreate session in memory
      const s = dbSession[0];
      // If status is 'active', game has already started
      const gameStarted = s.status === 'active';
      activeSessions.set(sessionCode, {
        id: s.id,
        gameId: s.game_id,
        teacherId: s.teacher_id,
        status: s.status,
        gameStarted: gameStarted, // Set based on session status
        players: new Map(),
        teacherWs: null, // WebSocket for the teacher
        questions: [],
        createdAt: new Date()
      });
    }

    const currentSession = activeSessions.get(sessionCode);
    
    // Update gameStarted flag if session status changed (e.g., loaded from DB)
    if (currentSession && currentSession.status === 'active' && !currentSession.gameStarted) {
      currentSession.gameStarted = true;
    }

    // If teacher is joining, store their WebSocket
    if (ws.userRole === 'teacher') {
      currentSession.teacherWs = ws;
      // Send initial lobby update to teacher
      this.broadcastLobbyUpdate(sessionCode);
      ws.send(JSON.stringify({
        type: 'connected',
        sessionCode: sessionCode,
        userId: ws.userId
      }));
      return; // Don't add teacher as a player
    }

    // Get student nickname from database if not provided
    let nickname = studentNickname;
    if (!nickname) {
      const student = await sql`
        SELECT nickname FROM users WHERE student_id = ${studentId}
      `;
      nickname = student[0]?.nickname || studentName;
    }

        // Check if player already exists (reconnection scenario)
    const existingPlayer = currentSession.players.get(studentId);
    if (existingPlayer) {
      // Update WebSocket for existing player (reconnection)
      console.log(`[GameManager] Player ${studentId} reconnecting, updating WebSocket`, {
        gameStarted: currentSession.gameStarted,
        inLobby: existingPlayer.inLobby,
        selectedCharacter: existingPlayer.selectedCharacter
      });
      existingPlayer.ws = ws;
      // Don't reset their game state - keep their progress
      
      // Determine where to send reconnecting player based on their state
      if (currentSession.gameStarted && existingPlayer.inLobby) {
        // Game has started and they were in lobby - send them to cards phase
        const gameQuestions = await sql`
          SELECT id, question_text, option_a, option_b, option_c, option_d, correct_answer, question_image
          FROM mini_game_questions
          WHERE game_id = ${currentSession.gameId}
        `;
        const randomQuestions = getRandomQuestions(gameQuestions, 3);
        
        ws.send(JSON.stringify({
          type: 'start-card-phase',
          questions: randomQuestions,
          lateJoiner: true,
          assignedCharacter: existingPlayer.selectedCharacter
        }));
      } else if (!currentSession.gameStarted && existingPlayer.inLobby) {
        // Game hasn't started but they were in lobby - send them back to lobby
        const lobbyPlayers = Array.from(currentSession.players.values())
          .filter(p => p.inLobby)
          .map(p => ({
            studentId: p.studentId,
            studentName: p.studentName,
            studentNickname: p.studentNickname,
            selectedCharacter: p.selectedCharacter
          }));
        
        ws.send(JSON.stringify({
          type: 'lobby-joined',
          players: lobbyPlayers
        }));
      } else if (!currentSession.gameStarted && existingPlayer.selectedCharacter) {
        // Game hasn't started, they selected a character but not in lobby - send character selection
        // (they can join lobby again)
        ws.send(JSON.stringify({
          type: 'character-selection',
          characters: ['archer', 'swordsman', 'wizard', 'enchantress', 'knight', 'musketeer'],
          studentNickname: nickname,
          preselectedCharacter: existingPlayer.selectedCharacter // Show their previous selection
        }));
      } else if (!currentSession.gameStarted) {
        // Game hasn't started and no character selected - send character selection
        ws.send(JSON.stringify({
          type: 'character-selection',
          characters: ['archer', 'swordsman', 'wizard', 'enchantress', 'knight', 'musketeer'],
          studentNickname: nickname
        }));
      }
      
      return; // Player already exists, just updated WebSocket
    }

    // Add new player to session
        currentSession.players.set(studentId, {
          ws,
          studentId,
          studentName,
          studentNickname: nickname, // Store nickname from database
          selectedCharacter: null, // Will be set during character selection
          inLobby: false, // Not in lobby yet
          cardsAnswered: 0,
          correctAnswers: 0,
          damage: 5, // Base damage
          hp: 200,
          inQueue: false,
          matchId: null,
          damageDealt: 0, // Track damage dealt in battles
          damageReceived: 0 // Track damage received in battles
        });

    // Load questions if not loaded
    if (currentSession.questions.length === 0) {
      const questions = await sql`
        SELECT id, question_id, question_text, question_image_url,
               option_a, option_b, option_c, option_d, correct_answer
        FROM mini_game_questions
        WHERE game_id = ${currentSession.gameId}
        ORDER BY question_id
      `;
      currentSession.questions = questions;
    }

    // If game has already started, send student directly to card phase
    if (currentSession.gameStarted || currentSession.status === 'active') {
      // Assign a random character for late joiners
      const characters = ['archer', 'swordsman', 'wizard', 'enchantress', 'knight', 'musketeer'];
      const randomCharacter = characters[Math.floor(Math.random() * characters.length)];
      const player = currentSession.players.get(studentId);
      if (player) {
        player.selectedCharacter = randomCharacter;
        player.inLobby = true; // Mark as in lobby so they can participate
      }
      
          // Send directly to card phase with random questions
          const randomQuestions = getRandomQuestions(currentSession.questions, 3);
          ws.send(JSON.stringify({
            type: 'start-card-phase',
            questions: randomQuestions, // Random 3 questions
            lateJoiner: true, // Flag to indicate this is a late joiner
            assignedCharacter: randomCharacter
          }));
    } else {
      // Game hasn't started yet - send character selection screen
      ws.send(JSON.stringify({
        type: 'character-selection',
        characters: [
          { id: 'archer', name: 'Archer', gender: 'men', preview: '/art/characters/men/Archer/Idle.png' },
          { id: 'swordsman', name: 'Swordsman', gender: 'men', preview: '/art/characters/men/Swordsman/Idle.png' },
          { id: 'wizard', name: 'Wizard', gender: 'men', preview: '/art/characters/men/Wizard/Idle.png' },
          { id: 'enchantress', name: 'Enchantress', gender: 'women', preview: '/art/characters/women/Enchantress/Idle.png' },
          { id: 'knight', name: 'Knight', gender: 'women', preview: '/art/characters/women/Knight/Idle.png' },
          { id: 'musketeer', name: 'Musketeer', gender: 'women', preview: '/art/characters/women/Musketeer/Idle.png' }
        ],
        studentNickname: nickname
      }));
    }

    // Notify teacher of new player (if teacher is connected)
    this.broadcastToTeacher(sessionCode, {
      type: 'player-joined',
      studentId,
      studentName,
      studentNickname: nickname,
      playerCount: currentSession.players.size
    });
  }

  // Handle character selection
  async handleCharacterSelection(ws, payload) {
    const { sessionCode, studentId, characterId } = payload;
    const session = activeSessions.get(sessionCode);
    if (!session) return;

    const player = session.players.get(studentId);
    if (!player) return;

    // Store selected character
    player.selectedCharacter = characterId;
    player.inLobby = false; // Not in lobby yet

    // Confirm selection (don't start card phase yet - wait for lobby join)
    ws.send(JSON.stringify({
      type: 'character-selected',
      characterId,
      studentNickname: player.studentNickname
    }));
  }

  // Handle join lobby
  async handleJoinLobby(ws, payload) {
    const { sessionCode, studentId } = payload;
    const session = activeSessions.get(sessionCode);
    if (!session) return;

    const player = session.players.get(studentId);
    if (!player) return;

    // Check if character is selected
    if (!player.selectedCharacter) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Please select a character first'
      }));
      return;
    }

    // Add to lobby
    player.inLobby = true;

    // Get all players in lobby
    const lobbyPlayers = Array.from(session.players.values())
      .filter(p => p.inLobby)
      .map(p => ({
        studentId: p.studentId,
        studentName: p.studentName,
        studentNickname: p.studentNickname,
        selectedCharacter: p.selectedCharacter
      }));

    // Confirm lobby join
    ws.send(JSON.stringify({
      type: 'lobby-joined',
      players: lobbyPlayers
    }));

    // Broadcast lobby update to all players (including teacher)
    this.broadcastLobbyUpdate(sessionCode);
  }

  // Broadcast lobby update to all players and teacher
  broadcastLobbyUpdate(sessionCode) {
    const session = activeSessions.get(sessionCode);
    if (!session) return;

    const lobbyPlayers = Array.from(session.players.values())
      .filter(p => p.inLobby)
      .map(p => ({
        studentId: p.studentId,
        studentName: p.studentName,
        studentNickname: p.studentNickname,
        selectedCharacter: p.selectedCharacter
      }));

    // Send to all players in session
    session.players.forEach(player => {
      if (player.ws && player.ws.readyState === 1) { // WebSocket.OPEN
        player.ws.send(JSON.stringify({
          type: 'lobby-update',
          players: lobbyPlayers
        }));
      }
    });

    // Also send to teacher if connected
    if (session.teacherWs && session.teacherWs.readyState === 1) { // WebSocket.OPEN
      session.teacherWs.send(JSON.stringify({
        type: 'lobby-update',
        players: lobbyPlayers
      }));
    }
  }

  // Handle start game (from teacher)
  async handleStartGame(ws, payload) {
    const { sessionCode } = payload;
    const session = activeSessions.get(sessionCode);
    if (!session) return;

    // Check if user is teacher
    if (ws.userRole !== 'teacher') {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Only teacher can start the game'
      }));
      return;
    }

    // Get all players in lobby
    const lobbyPlayers = Array.from(session.players.values())
      .filter(p => p.inLobby);

    if (lobbyPlayers.length === 0) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'No players in lobby'
      }));
      return;
    }

    // Mark game as started
    session.gameStarted = true;

    // Start card phase for all players in lobby with random questions
    // Each player gets their own random set of 3 questions
    lobbyPlayers.forEach(player => {
      if (player.ws && player.ws.readyState === 1) { // WebSocket.OPEN
        const randomQuestions = getRandomQuestions(session.questions, 3);
        player.ws.send(JSON.stringify({
          type: 'start-card-phase',
          questions: randomQuestions // Random 3 questions for each player
        }));
      }
    });

    // Update session status
    session.status = 'active';

    // Notify teacher that game started
    if (session.teacherWs && session.teacherWs.readyState === 1) {
      session.teacherWs.send(JSON.stringify({
        type: 'game-started',
        sessionCode
      }));
    }

    // Start sending player stats updates to teacher
    this.startPlayerStatsUpdates(sessionCode);
  }

  // Start periodic player stats updates for teacher
  startPlayerStatsUpdates(sessionCode) {
    const session = activeSessions.get(sessionCode);
    if (!session) return;

    // Clear any existing interval
    if (session.statsUpdateInterval) {
      clearInterval(session.statsUpdateInterval);
    }

    // Send stats every 2 seconds
    session.statsUpdateInterval = setInterval(() => {
      this.sendPlayerStatsToTeacher(sessionCode);
    }, 2000);

    // Send initial stats immediately
    this.sendPlayerStatsToTeacher(sessionCode);
  }

  // Send player stats to teacher
  sendPlayerStatsToTeacher(sessionCode) {
    const session = activeSessions.get(sessionCode);
    if (!session || !session.teacherWs) return;

    if (session.teacherWs.readyState !== 1) return; // WebSocket.OPEN

    const stats = Array.from(session.players.values()).map(player => ({
      studentId: player.studentId,
      studentName: player.studentName,
      studentNickname: player.studentNickname,
      selectedCharacter: player.selectedCharacter,
      correctAnswers: player.correctAnswers || 0,
      cardsAnswered: player.cardsAnswered || 0,
      damage: player.damage || 5,
      hp: player.hp || 200,
      damageDealt: player.damageDealt || 0,
      damageReceived: player.damageReceived || 0
    }));

    session.teacherWs.send(JSON.stringify({
      type: 'player-stats-update',
      stats
    }));
  }

  // Handle finish game (from teacher)
  async handleFinishGame(ws, payload) {
    const { sessionCode } = payload;
    const session = activeSessions.get(sessionCode);
    if (!session) return;

    // Check if user is teacher
    if (ws.userRole !== 'teacher') {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Only teacher can finish the game'
      }));
      return;
    }

    // Stop stats updates
    if (session.statsUpdateInterval) {
      clearInterval(session.statsUpdateInterval);
      session.statsUpdateInterval = null;
    }

    // Notify all players that game is finished
    session.players.forEach(player => {
      if (player.ws && player.ws.readyState === 1) {
        player.ws.send(JSON.stringify({
          type: 'game-finished',
          message: 'Teacher has finished the game'
        }));
        // Close player connections
        player.ws.close();
      }
    });

    // Update session status in database
    await sql`
      UPDATE mini_game_sessions
      SET status = 'completed'
      WHERE session_code = ${sessionCode}
    `;

    // Notify teacher
    ws.send(JSON.stringify({
      type: 'game-finished',
      message: 'Game finished successfully'
    }));

    // Close teacher connection
    if (session.teacherWs && session.teacherWs.readyState === 1) {
      session.teacherWs.close();
    }

    // Clean up session
    activeSessions.delete(sessionCode);
  }

  // Handle card answer
  async handleCardAnswer(ws, payload) {
    const { sessionCode, questionId, answer, studentId } = payload;
    const session = activeSessions.get(sessionCode);
    if (!session) return;

    const player = session.players.get(studentId);
    if (!player) return;

    // Find question
    const question = session.questions.find(q => q.question_id === questionId);
    if (!question) return;

    const isCorrect = question.correct_answer === answer;
    player.cardsAnswered++;

    if (isCorrect) {
      player.correctAnswers++;
      player.damage += 5; // Add 5 points per correct answer
    }

    // Send result to student
    ws.send(JSON.stringify({
      type: 'card-result',
      questionId,
      isCorrect,
      currentDamage: player.damage,
      cardsRemaining: 3 - player.cardsAnswered
    }));

    // If all 3 cards answered, notify ready for queue
    if (player.cardsAnswered === 3) {
      ws.send(JSON.stringify({
        type: 'cards-complete',
        correctAnswers: player.correctAnswers,
        finalDamage: player.damage
      }));
    }
    
    // Update teacher stats immediately when card is answered
    this.sendPlayerStatsToTeacher(sessionCode);
  }

  // Broadcast to teacher
  broadcastToTeacher(sessionCode, message) {
    const session = activeSessions.get(sessionCode);
    if (!session) return;

    // Find teacher's WebSocket (would need to track this)
    // For now, broadcast to all connections in session
    session.players.forEach((player) => {
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(message));
      }
    });
  }

  // Handle disconnection
  async handleDisconnect(sessionCode, userId) {
    const session = activeSessions.get(sessionCode);
    if (!session) return;

    session.players.delete(userId);

    // If no players left, mark session as inactive
    if (session.players.size === 0) {
      await sql`
        UPDATE mini_game_sessions
        SET status = 'cancelled'
        WHERE session_code = ${sessionCode}
      `;
      activeSessions.delete(sessionCode);
    }
  }

  // Generate unique session code
  generateSessionCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  // Get session
  getSession(sessionCode) {
    return activeSessions.get(sessionCode);
  }
}

module.exports = new GameManager();

