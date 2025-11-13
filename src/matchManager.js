const { neon } = require('@neondatabase/serverless');
const WebSocket = require('ws');

const sql = neon(process.env.NEON_DATABASE_URL);

// Store active matches
const activeMatches = new Map();

class MatchManager {
  // Create a 1v1 match
  async createMatch(sessionCode, player1, player2) {
    const matchId = `match_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    // Get player data from session
    const gameManager = require('./gameManager');
    const session = gameManager.getSession(sessionCode);
    
    const p1Data = session ? session.players.get(player1.studentId) : null;
    const p2Data = session ? session.players.get(player2.studentId) : null;
    
    const match = {
      id: matchId,
      sessionCode,
      player1: {
        id: player1.studentId,
        ws: player1.ws,
        nickname: player1.studentNickname,
        character: player1.selectedCharacter,
        hp: p1Data?.hp || 200,
        damage: player1.damage || 5,
        position: { x: 100, y: 300 }, // Left side
        ready: false,
        correctAnswers: p1Data?.correctAnswers || 0
      },
      player2: {
        id: player2.studentId,
        ws: player2.ws,
        nickname: player2.studentNickname,
        character: player2.selectedCharacter,
        hp: p2Data?.hp || 200,
        damage: player2.damage || 5,
        position: { x: 700, y: 300 }, // Right side
        ready: false,
        correctAnswers: p2Data?.correctAnswers || 0
      },
      currentRound: 0,
      roundTimer: null,
      status: 'waiting', // waiting, active, completed
      activeSpells: []
    };

    activeMatches.set(matchId, match);

    // Store match ID in WebSocket
    player1.ws.matchId = matchId;
    player1.ws.playerId = 'player1';
    player2.ws.matchId = matchId;
    player2.ws.playerId = 'player2';

    return matchId;
  }

  // Handle round ready (both players ready)
  async handleRoundReady(ws, payload) {
    const { matchId } = payload;
    const match = activeMatches.get(matchId);
    if (!match) return;

    const player = match[ws.playerId];
    if (!player) return;

    player.ready = true;

    // If both players ready, start round
    if (match.player1.ready && match.player2.ready) {
      this.startRound(matchId);
    }
  }

  // Handle player movement
  async handlePlayerMove(ws, payload) {
    const { matchId, position } = payload;
    const match = activeMatches.get(matchId);
    if (!match || match.status !== 'active') return;

    const player = match[ws.playerId];
    if (!player) return;

    // Update position (validate bounds - own half only)
    player.position = this.validatePosition(position, ws.playerId);

    // Broadcast to opponent
    const opponent = ws.playerId === 'player1' ? match.player2 : match.player1;
    if (opponent.ws.readyState === WebSocket.OPEN) {
      opponent.ws.send(JSON.stringify({
        type: 'opponent-move',
        position: player.position,
        playerId: ws.playerId
      }));
    }
  }

  // Handle spell cast
  async handleSpellCast(ws, payload) {
    const { matchId, spellType, direction } = payload;
    const match = activeMatches.get(matchId);
    if (!match || match.status !== 'active') return;

    const player = match[ws.playerId];
    if (!player) return;

    // Calculate spell damage
    const damage = this.calculateSpellDamage(spellType, player.damage);

    // Create spell projectile - offset from player position to avoid immediate collision
    const offsetDistance = 40;
    const opponent = ws.playerId === 'player1' ? match.player2 : match.player1;
    
    // Calculate offset direction (towards opponent)
    let startPosition;
    if (direction === 1) {
      // Moving right/up - offset in that direction
      startPosition = {
        x: player.position.x + offsetDistance,
        y: player.position.y
      };
    } else {
      // Moving left/down - offset in that direction
      startPosition = {
        x: player.position.x - offsetDistance,
        y: player.position.y
      };
    }
    
    // Calculate target position (opponent's position)
    const targetPosition = { ...opponent.position };
    
    const spell = {
      id: `spell_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      type: spellType,
      startPosition,
      targetPosition,
      direction,
      damage,
      speed: spellType === 'fire_arrow' ? 10 : 5,
      owner: ws.playerId,
      casterId: ws.playerId, // Also include casterId for client compatibility
      createdAt: Date.now()
    };

    match.activeSpells.push(spell);

    // Broadcast spell to both players
    if (match.player1.ws.readyState === WebSocket.OPEN) {
      match.player1.ws.send(JSON.stringify({
        type: 'spell-cast',
        spell
      }));
    }
    if (match.player2.ws.readyState === WebSocket.OPEN) {
      match.player2.ws.send(JSON.stringify({
        type: 'spell-cast',
        spell
      }));
    }
  }

  // Handle spell hit (called from client collision detection)
  async handleSpellHit(matchId, spellId, hitPlayerId) {
    console.log('[MatchManager] handleSpellHit called:', { matchId, spellId, hitPlayerId });
    const match = activeMatches.get(matchId);
    if (!match) {
      console.log('[MatchManager] Match not found:', matchId);
      return;
    }

    // Find spell
    const spellIndex = match.activeSpells.findIndex(s => s.id === spellId);
    if (spellIndex === -1) {
      console.log('[MatchManager] Spell not found in active spells:', spellId, 'Active spells:', match.activeSpells.map(s => s.id));
      return;
    }

    const spell = match.activeSpells[spellIndex];
    const hitPlayer = match[hitPlayerId];
    const caster = match[spell.owner];

    if (!hitPlayer) {
      console.log('[MatchManager] Hit player not found:', hitPlayerId, 'Available:', Object.keys(match).filter(k => k !== 'activeSpells' && k !== 'roundTimer'));
      return;
    }
    if (!caster) {
      console.log('[MatchManager] Caster not found:', spell.owner);
      return;
    }

    console.log('[MatchManager] Processing spell hit:', {
      spellId,
      hitPlayerId,
      hitPlayerHp: hitPlayer.hp,
      spellDamage: spell.damage,
      caster: spell.owner
    });

    // Remove spell
    match.activeSpells.splice(spellIndex, 1);

    // Apply damage
    const oldHp = hitPlayer.hp;
    const damageAmount = spell.damage;
    const calculatedNewHp = oldHp - damageAmount;
    hitPlayer.hp = Math.max(0, calculatedNewHp);
    const finalHp = hitPlayer.hp;

    console.log('[MatchManager] HP Calculation:', {
      hitPlayerId,
      currentHp: oldHp,
      damageAmount: damageAmount,
      calculation: `${oldHp} - ${damageAmount} = ${calculatedNewHp}`,
      finalHp: finalHp,
      clamped: calculatedNewHp < 0 ? `(clamped from ${calculatedNewHp} to 0)` : '(no clamping needed)'
    });

    // Track damage stats
    if (!caster.damageDealt) caster.damageDealt = 0;
    if (!hitPlayer.damageReceived) hitPlayer.damageReceived = 0;
    caster.damageDealt += spell.damage;
    hitPlayer.damageReceived += spell.damage;

    // Broadcast damage
    console.log('[MatchManager] Broadcasting spell-hit to players:', {
      player1Hp: match.player1.hp,
      player2Hp: match.player2.hp,
      hitPlayerId,
      remainingHp: hitPlayer.hp,
      damage: damageAmount
    });
    
    if (match.player1.ws.readyState === WebSocket.OPEN) {
      const message = {
        type: 'spell-hit',
        spellId,
        target: hitPlayerId,
        damage: spell.damage,
        remainingHp: hitPlayer.hp,
        oldHp,
        player1Hp: match.player1.hp,
        player2Hp: match.player2.hp
      };
      console.log('[MatchManager] Sending to player1:', message);
      match.player1.ws.send(JSON.stringify(message));
    }
    if (match.player2.ws.readyState === WebSocket.OPEN) {
      const message = {
        type: 'spell-hit',
        spellId,
        target: hitPlayerId,
        damage: spell.damage,
        remainingHp: hitPlayer.hp,
        oldHp,
        player1Hp: match.player1.hp,
        player2Hp: match.player2.hp
      };
      console.log('[MatchManager] Sending to player2:', message);
      match.player2.ws.send(JSON.stringify(message));
    }

    // Check for game end
    if (hitPlayer.hp <= 0) {
      await this.endMatch(matchId, caster.id);
    }
  }

  // Start round
  startRound(matchId) {
    const match = activeMatches.get(matchId);
    if (!match) return;

    match.status = 'active';
    match.currentRound++;
    match.player1.ready = false;
    match.player2.ready = false;
    
    // Clear previous round spells
    match.activeSpells = [];

    // Set round timer (10 seconds)
    match.roundTimer = setTimeout(() => {
      this.endRound(matchId);
    }, 10000);

    // Notify both players
    if (match.player1.ws.readyState === WebSocket.OPEN) {
      match.player1.ws.send(JSON.stringify({
        type: 'round-start',
        round: match.currentRound,
        duration: 10000,
        player1Hp: match.player1.hp,
        player2Hp: match.player2.hp
      }));
    }
    if (match.player2.ws.readyState === WebSocket.OPEN) {
      match.player2.ws.send(JSON.stringify({
        type: 'round-start',
        round: match.currentRound,
        duration: 10000,
        player1Hp: match.player1.hp,
        player2Hp: match.player2.hp
      }));
    }
  }

  // End round
  endRound(matchId) {
    const match = activeMatches.get(matchId);
    if (!match) return;

    if (match.roundTimer) {
      clearTimeout(match.roundTimer);
      match.roundTimer = null;
    }

    match.status = 'waiting';

    // Recalculate damage for next round (not stored, recalculated from cards)
    // HP carries over

    // Notify both players
    if (match.player1.ws.readyState === WebSocket.OPEN) {
      match.player1.ws.send(JSON.stringify({
        type: 'round-end',
        round: match.currentRound,
        player1Hp: match.player1.hp,
        player2Hp: match.player2.hp
      }));
    }
    if (match.player2.ws.readyState === WebSocket.OPEN) {
      match.player2.ws.send(JSON.stringify({
        type: 'round-end',
        round: match.currentRound,
        player1Hp: match.player1.hp,
        player2Hp: match.player2.hp
      }));
    }

    // Start next round after 3 second break (if both players still alive)
    if (match.player1.hp > 0 && match.player2.hp > 0) {
      setTimeout(() => {
        this.startRound(matchId);
      }, 3000);
    } else {
      // Game ended during round
      const winnerId = match.player1.hp > 0 ? match.player1.id : match.player2.id;
      this.endMatch(matchId, winnerId);
    }
  }

  // End match
  async endMatch(matchId, winnerId) {
    const match = activeMatches.get(matchId);
    if (!match) return;

    match.status = 'completed';
    if (match.roundTimer) {
      clearTimeout(match.roundTimer);
    }

    const winner = match[winnerId === match.player1.id ? 'player1' : 'player2'];
    const loser = match[winnerId === match.player1.id ? 'player2' : 'player1'];

    // Update player HP in session
    const gameManager = require('./gameManager');
    const session = gameManager.getSession(match.sessionCode);
    if (session) {
      const winnerPlayer = session.players.get(winner.id);
      const loserPlayer = session.players.get(loser.id);
      
      if (winnerPlayer) {
        winnerPlayer.hp = winner.hp; // Update HP from match
        winnerPlayer.damageDealt = (winnerPlayer.damageDealt || 0) + (winner.damageDealt || 0);
      }
      
      if (loserPlayer) {
        loserPlayer.hp = 0; // Eliminated
        loserPlayer.damageReceived = (loserPlayer.damageReceived || 0) + (loser.damageReceived || 0);
        loserPlayer.eliminated = true;
      }
    }

    // Get session data for database
    const sessionResult = await sql`
      SELECT id, game_id FROM mini_game_sessions WHERE session_code = ${match.sessionCode}
    `;
    const dbSession = sessionResult[0];
    if (!dbSession) {
      console.error('Session not found for match:', matchId);
      return;
    }

    // Get student data for database
    const winnerData = await sql`
      SELECT name, surname, grade, class, number FROM users WHERE student_id = ${winner.id}
    `;
    const loserData = await sql`
      SELECT name, surname, grade, class, number FROM users WHERE student_id = ${loser.id}
    `;

    const winnerUser = winnerData[0];
    const loserUser = loserData[0];

    // Save results to database
    if (winnerUser && loserUser) {
      await sql`
        INSERT INTO mini_game_results (
          session_id, game_id, student_id, name, surname,
          nickname, grade, class, number,
          correct_cards, xp_earned, damage_dealt, damage_received,
          final_place, final_hp, completed_at
        ) VALUES (
          ${dbSession.id}, ${dbSession.game_id}, ${winner.id},
          ${winnerUser.name}, ${winnerUser.surname}, ${winner.nickname},
          ${winnerUser.grade}, ${winnerUser.class}, ${winnerUser.number},
          ${winner.correctAnswers || 0}, ${(winner.correctAnswers || 0) * 10},
          ${winner.damageDealt || 0}, ${winner.damageReceived || 0},
          1, ${winner.hp}, CURRENT_TIMESTAMP
        ), (
          ${dbSession.id}, ${dbSession.game_id}, ${loser.id},
          ${loserUser.name}, ${loserUser.surname}, ${loser.nickname},
          ${loserUser.grade}, ${loserUser.class}, ${loserUser.number},
          ${loser.correctAnswers || 0}, ${(loser.correctAnswers || 0) * 10},
          ${loser.damageDealt || 0}, ${loser.damageReceived || 0},
          2, ${loser.hp}, CURRENT_TIMESTAMP
        )
      `;
    }

    // Notify both players
    if (match.player1.ws.readyState === WebSocket.OPEN) {
      match.player1.ws.send(JSON.stringify({
        type: 'match-end',
        winner: winnerId,
        results: {
          player1: {
            id: match.player1.id,
            nickname: match.player1.nickname,
            hp: match.player1.hp,
            place: winnerId === match.player1.id ? 1 : 2,
            correctAnswers: match.player1.correctAnswers,
            damageDealt: match.player1.damageDealt || 0,
            damageReceived: match.player1.damageReceived || 0
          },
          player2: {
            id: match.player2.id,
            nickname: match.player2.nickname,
            hp: match.player2.hp,
            place: winnerId === match.player2.id ? 1 : 2,
            correctAnswers: match.player2.correctAnswers,
            damageDealt: match.player2.damageDealt || 0,
            damageReceived: match.player2.damageReceived || 0
          }
        }
      }));
    }
    if (match.player2.ws.readyState === WebSocket.OPEN) {
      match.player2.ws.send(JSON.stringify({
        type: 'match-end',
        winner: winnerId,
        results: {
          player1: {
            id: match.player1.id,
            nickname: match.player1.nickname,
            hp: match.player1.hp,
            place: winnerId === match.player1.id ? 1 : 2,
            correctAnswers: match.player1.correctAnswers,
            damageDealt: match.player1.damageDealt || 0,
            damageReceived: match.player1.damageReceived || 0
          },
          player2: {
            id: match.player2.id,
            nickname: match.player2.nickname,
            hp: match.player2.hp,
            place: winnerId === match.player2.id ? 1 : 2,
            correctAnswers: match.player2.correctAnswers,
            damageDealt: match.player2.damageDealt || 0,
            damageReceived: match.player2.damageReceived || 0
          }
        }
      }));
    }

    // Cleanup
    activeMatches.delete(matchId);

    // Tournament system: Check if tournament should continue
    if (session) {
      const activePlayers = Array.from(session.players.values()).filter(p => p.hp > 0 && !p.eliminated);
      
      if (activePlayers.length > 1) {
        // Tournament continues - winner can re-enter queue if they have HP > 0
        if (winner.hp > 0 && winnerPlayer && !winnerPlayer.inQueue && !winnerPlayer.matchId) {
          // Winner can re-enter queue for next match
          // This will be handled when they call enter-queue again
        }
      } else if (activePlayers.length === 1) {
        // Tournament complete - one winner remains
        const finalWinner = activePlayers[0];
        
        // Broadcast tournament end to all players
        session.players.forEach((player) => {
          if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
              type: 'tournament-end',
              winner: {
                id: finalWinner.studentId,
                nickname: finalWinner.studentNickname,
                hp: finalWinner.hp,
                correctAnswers: finalWinner.correctAnswers,
                damageDealt: finalWinner.damageDealt || 0,
                damageReceived: finalWinner.damageReceived || 0
              }
            }));
          }
        });

        // Mark session as completed
        await sql`
          UPDATE mini_game_sessions
          SET status = 'completed', ended_at = CURRENT_TIMESTAMP
          WHERE session_code = ${match.sessionCode}
        `;
      }
    }
  }

  // Handle player disconnect during match
  async handlePlayerDisconnect(matchId, playerId) {
    const match = activeMatches.get(matchId);
    if (!match) return;

    // End match, opponent wins
    const opponentId = playerId === 'player1' ? match.player2.id : match.player1.id;
    await this.endMatch(matchId, opponentId);
  }

  // Validate position (keep in own half)
  validatePosition(position, playerId) {
    const maxX = playerId === 'player1' ? 400 : 800;
    const minX = playerId === 'player1' ? 0 : 400;
    const maxY = 600;
    const minY = 0;

    return {
      x: Math.max(minX, Math.min(maxX, position.x)),
      y: Math.max(minY, Math.min(maxY, position.y))
    };
  }

  // Calculate spell damage
  calculateSpellDamage(spellType, baseDamage) {
    if (spellType === 'fire_arrow') {
      return baseDamage;
    } else if (spellType === 'water_spell') {
      return Math.floor(baseDamage * 1.5);
    }
    return baseDamage;
  }

  // Get match
  getMatch(matchId) {
    return activeMatches.get(matchId);
  }
}

module.exports = new MatchManager();

