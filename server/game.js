const crypto = require('crypto');
const Rules = require('../public/rules.js');

const RACK_SIZE = 14;

function createTiles() {
  const tiles = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const color of Rules.COLORS) {
      for (let n = 1; n <= Rules.MAX_NUMBER; n++) tiles.push({ id: tiles.length, color, number: n, joker: false });
    }
  }
  tiles.push({ id: tiles.length, color: 'joker', number: 0, joker: true });
  tiles.push({ id: tiles.length, color: 'joker', number: 0, joker: true });
  return tiles;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class Game {
  constructor(playerIds) {
    this.tiles = createTiles();
    this.pool = shuffle(this.tiles.map((t) => t.id));
    this.players = playerIds.map((id) => ({ id, rack: this.pool.splice(0, RACK_SIZE), hasMelded: false }));
    this.board = [];
    this.current = crypto.randomInt(this.players.length);
    this.turnNumber = 1;
    this.passesInRow = 0;
    this.finished = false;
    this.result = null;
  }

  get currentPlayer() {
    return this.players[this.current];
  }

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  isTurnOf(id) {
    return !this.finished && this.currentPlayer.id === id;
  }

  // Draws a tile (or passes when the pool is empty) and ends the turn.
  draw(playerId) {
    if (!this.isTurnOf(playerId)) return { ok: false, error: 'Je bent niet aan de beurt.' };
    const p = this.currentPlayer;
    let tileId = null;
    if (this.pool.length) {
      tileId = this.pool.pop();
      p.rack.push(tileId);
      this.passesInRow = 0;
    } else {
      this.passesInRow++;
      if (this.passesInRow >= this.players.length) {
        this.finish(null);
        return { ok: true, tileId, passed: true };
      }
    }
    this.nextTurn();
    return { ok: true, tileId, passed: tileId === null };
  }

  play(playerId, newBoard) {
    if (!this.isTurnOf(playerId)) return { ok: false, error: 'Je bent niet aan de beurt.' };
    const p = this.currentPlayer;
    const res = Rules.validateMove({
      oldBoard: this.board,
      newBoard,
      rack: p.rack,
      tiles: this.tiles,
      hasMelded: p.hasMelded,
    });
    if (!res.ok) return res;
    const played = new Set(res.played);
    this.board = res.board;
    p.rack = p.rack.filter((id) => !played.has(id));
    p.hasMelded = true;
    this.passesInRow = 0;
    if (!p.rack.length) this.finish(p.id);
    else this.nextTurn();
    return res;
  }

  nextTurn() {
    this.current = (this.current + 1) % this.players.length;
    this.turnNumber++;
  }

  // winnerId null = pool empty and nobody could play: lowest rack value wins.
  finish(winnerId) {
    const penalties = this.players.map((p) => ({
      id: p.id,
      penalty: Rules.rackPenalty(p.rack.map((id) => this.tiles[id])),
    }));
    if (winnerId === null) {
      winnerId = penalties.reduce((best, p) => (p.penalty < best.penalty ? p : best)).id;
    }
    const total = penalties.filter((p) => p.id !== winnerId).reduce((s, p) => s + p.penalty, 0);
    this.finished = true;
    this.result = {
      winnerId,
      players: penalties.map((p) => ({
        id: p.id,
        penalty: p.penalty,
        roundScore: p.id === winnerId ? total : -p.penalty,
        rack: this.player(p.id).rack.map((id) => this.tiles[id]),
      })),
    };
  }

  stateFor(playerId) {
    const me = this.player(playerId);
    return {
      board: this.board.map((set) => set.map((id) => this.tiles[id])),
      poolCount: this.pool.length,
      currentPlayerId: this.currentPlayer.id,
      turnNumber: this.turnNumber,
      players: this.players.map((p) => ({ id: p.id, rackCount: p.rack.length, hasMelded: p.hasMelded })),
      myRack: me ? me.rack.map((id) => this.tiles[id]) : [],
      hasMelded: me ? me.hasMelded : false,
      finished: this.finished,
      result: this.result,
    };
  }
}

module.exports = { Game, createTiles };
