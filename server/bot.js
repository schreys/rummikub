const Rules = require('../public/rules.js');

const SEARCH_LIMIT = 40000;
const J = 'J';

function combinations(arr, k, start = 0, prefix = [], out = []) {
  if (prefix.length === k) {
    out.push(prefix.slice());
    return out;
  }
  for (let i = start; i < arr.length; i++) {
    prefix.push(arr[i]);
    combinations(arr, k, i + 1, prefix, out);
    prefix.pop();
  }
  return out;
}

// Candidate sets from the rack; layout contains tile ids and 'J' placeholders for jokers.
function findCandidates(rackTiles, jokerCount) {
  const real = rackTiles.filter((t) => !t.joker);
  const cands = [];
  const add = (layout, points) => {
    const ids = layout.filter((x) => x !== J);
    if (!ids.length) return;
    cands.push({ layout, ids, jokers: layout.length - ids.length, points });
  };

  for (let n = 1; n <= Rules.MAX_NUMBER; n++) {
    const byColor = new Map();
    for (const t of real) if (t.number === n && !byColor.has(t.color)) byColor.set(t.color, t.id);
    const avail = [...byColor.values()];
    for (let size = 3; size <= 4; size++) {
      for (let jk = 0; jk <= Math.min(jokerCount, size - 1); jk++) {
        if (size - jk > avail.length) continue;
        for (const combo of combinations(avail, size - jk)) add([...combo, ...Array(jk).fill(J)], n * size);
      }
    }
  }

  for (const color of Rules.COLORS) {
    const byNum = new Map();
    for (const t of real) if (t.color === color && !byNum.has(t.number)) byNum.set(t.number, t.id);
    for (let start = 1; start <= Rules.MAX_NUMBER - 2; start++) {
      const layout = [];
      let missing = 0;
      let points = 0;
      for (let v = start; v <= Rules.MAX_NUMBER; v++) {
        if (byNum.has(v)) layout.push(byNum.get(v));
        else {
          layout.push(J);
          missing++;
        }
        if (missing > jokerCount) break;
        points += v;
        if (layout.length >= 3) add(layout.slice(), points);
      }
    }
  }
  return cands;
}

function chooseSets(cands, jokerCount, needPoints) {
  cands.sort((a, b) => b.ids.length - a.ids.length || b.points - a.points);
  const used = new Set();
  const chosen = [];
  let best = { score: 0, sets: [] };
  let nodes = 0;

  const search = (i, jokersLeft, tiles, jokersUsed, points) => {
    if (points >= needPoints) {
      const score = tiles * 10 - jokersUsed * 4 + points * 0.01;
      if (score > best.score) best = { score, sets: chosen.slice() };
    }
    for (let j = i; j < cands.length; j++) {
      if (++nodes > SEARCH_LIMIT) return;
      const c = cands[j];
      if (c.jokers > jokersLeft || c.ids.some((id) => used.has(id))) continue;
      c.ids.forEach((id) => used.add(id));
      chosen.push(c);
      search(j + 1, jokersLeft - c.jokers, tiles + c.ids.length, jokersUsed + c.jokers, points + c.points);
      chosen.pop();
      c.ids.forEach((id) => used.delete(id));
    }
  };
  search(0, jokerCount, 0, 0, 0);
  return best.sets;
}

// Lays single rack tiles onto existing sets: at either end, or by splitting a long run.
function extendBoard(board, rack, tiles) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of rack.slice()) {
      if (tiles[id].joker) continue;
      for (let s = 0; s < board.length && !changed; s++) {
        const set = board[s];
        const options = [[...set, id], [id, ...set]];
        const a = Rules.analyzeSet(set.map((x) => tiles[x]));
        if (a && a.type === 'run' && set.length >= 5) {
          for (let i = 2; i <= set.length - 3; i++) {
            if (!tiles[set[i]].joker && a.values[i] === tiles[id].number && tiles[set[i]].color === tiles[id].color) {
              options.push({ split: [set.slice(0, i + 1), [id, ...set.slice(i + 1)]] });
            }
          }
        }
        for (const opt of options) {
          const parts = opt.split || [opt];
          if (parts.every((p) => Rules.analyzeSet(p.map((x) => tiles[x])))) {
            board.splice(s, 1, ...parts);
            rack.splice(rack.indexOf(id), 1);
            changed = true;
            break;
          }
        }
      }
    }
  }
}

/** Returns { type: 'play', board } or { type: 'draw' } for the current player of the game. */
function chooseBotMove(game) {
  const p = game.currentPlayer;
  const tiles = game.tiles;
  const rackTiles = p.rack.map((id) => tiles[id]);
  const jokerIds = rackTiles.filter((t) => t.joker).map((t) => t.id);
  const cands = findCandidates(rackTiles, jokerIds.length);
  const sets = chooseSets(cands, jokerIds.length, p.hasMelded ? 0 : Rules.MIN_INITIAL_MELD);

  const board = game.board.map((s) => s.slice());
  const rack = p.rack.slice();
  for (const c of sets) {
    const layout = c.layout.map((x) => (x === J ? jokerIds.shift() : x));
    board.push(layout);
    layout.forEach((id) => rack.splice(rack.indexOf(id), 1));
  }
  if (p.hasMelded) extendBoard(board, rack, tiles);

  if (rack.length === p.rack.length) return { type: 'draw' };
  return { type: 'play', board };
}

module.exports = { chooseBotMove };
