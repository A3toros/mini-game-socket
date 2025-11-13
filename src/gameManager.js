const { neon } = require('@neondatabase/serverless');
const WebSocket = require('ws');

const sql = neon(process.env.NEON_DATABASE_URL);

// Store active sessions in memory (can be moved to Redis for multi-instance)
const activeSessions = new Map();

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
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Session not found'
        }));
        return;
      }
      
      // Recreate session in memory
      const s = dbSession[0];
      activeSessions.set(sessionCode, {
        id: s.id,
        gameId: s.game_id,
        teacherId: s.teacher_id,
        status: s.status,
        gameStarted: false, // Always start as false - teacher must explicitly start
        players: new Map(),
        teacherWs: null, // WebSocket for the teacher
        questions: [],
        createdAt: new Date()
      });
    }

    const currentSession = activeSessions.get(sessionCode);

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

    // Add player to session
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
      matchId: null
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

    // Send character selection screen to student (before card phase)
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

    // Start card phase for all players in lobby
    lobbyPlayers.forEach(player => {
      if (player.ws && player.ws.readyState === 1) { // WebSocket.OPEN
        player.ws.send(JSON.stringify({
          type: 'start-card-phase',
          questions: session.questions.slice(0, 3) // First 3 questions
        }));
      }
    });

    // Update session status
    session.status = 'active';
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

