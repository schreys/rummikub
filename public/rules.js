// Shared game rules: loaded by the Node server (require) and the browser (window.Rules).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Rules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const COLORS = ['red', 'blue', 'orange', 'black'];
  const JOKER_PENALTY = 30;
  const MIN_INITIAL_MELD = 30;
  const MAX_NUMBER = 13;

  function runInOrder(tiles) {
    if (tiles.length > MAX_NUMBER) return null;
    const first = tiles.findIndex((t) => !t.joker);
    if (first < 0) return null;
    const color = tiles[first].color;
    const start = tiles[first].number - first;
    if (start < 1 || start + tiles.length - 1 > MAX_NUMBER) return null;
    const values = [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (!t.joker && (t.color !== color || t.number !== start + i)) return null;
      values.push(start + i);
    }
    return values;
  }

  function groupValues(tiles) {
    if (tiles.length > COLORS.length) return null;
    const real = tiles.filter((t) => !t.joker);
    if (!real.length) return null;
    const n = real[0].number;
    const colors = new Set();
    for (const t of real) {
      if (t.number !== n || colors.has(t.color)) return null;
      colors.add(t.color);
    }
    return tiles.map(() => n);
  }

  // Sorts a run that was laid out in the wrong order; jokers fill gaps, then extend upwards.
  function arrangeRun(tiles) {
    if (tiles.length > MAX_NUMBER) return null;
    const real = tiles.filter((t) => !t.joker).sort((a, b) => a.number - b.number);
    const jokers = tiles.filter((t) => t.joker);
    if (!real.length) return null;
    const color = real[0].color;
    for (let i = 0; i < real.length; i++) {
      if (real[i].color !== color) return null;
      if (i && real[i].number === real[i - 1].number) return null;
    }
    const min = real[0].number;
    const max = real[real.length - 1].number;
    const gaps = max - min + 1 - real.length;
    if (gaps > jokers.length) return null;
    let extra = jokers.length - gaps;
    const after = Math.min(extra, MAX_NUMBER - max);
    extra -= after;
    const start = min - extra;
    const end = max + after;
    if (start < 1) return null;
    const ordered = [];
    let ri = 0;
    let ji = 0;
    for (let v = start; v <= end; v++) {
      if (ri < real.length && real[ri].number === v) ordered.push(real[ri++]);
      else ordered.push(jokers[ji++]);
    }
    return { tiles: ordered, values: ordered.map((_, i) => start + i) };
  }

  // Returns { type, tiles (ordered), values } for a valid set, otherwise null.
  function analyzeSet(tiles) {
    if (!Array.isArray(tiles) || tiles.length < 3 || tiles.some((t) => !t)) return null;
    const run = runInOrder(tiles);
    if (run) return { type: 'run', tiles, values: run };
    const group = groupValues(tiles);
    if (group) return { type: 'group', tiles, values: group };
    const arranged = arrangeRun(tiles);
    if (arranged) return { type: 'run', tiles: arranged.tiles, values: arranged.values };
    return null;
  }

  function setPoints(tiles) {
    const a = analyzeSet(tiles);
    return a ? a.values.reduce((s, v) => s + v, 0) : 0;
  }

  function rackPenalty(tiles) {
    return tiles.reduce((s, t) => s + (t.joker ? JOKER_PENALTY : t.number), 0);
  }

  function setKey(ids) {
    return [...ids].sort((a, b) => a - b).join(',');
  }

  function fail(error) {
    return { ok: false, error };
  }

  /**
   * oldBoard/newBoard: arrays of arrays of tile ids. rack: tile ids of the player.
   * tiles: lookup id -> tile. Returns { ok, error?, board?, played?, points? }.
   */
  function validateMove({ oldBoard, newBoard, rack, tiles, hasMelded }) {
    if (!Array.isArray(newBoard) || newBoard.some((s) => !Array.isArray(s))) return fail('Ongeldig bord.');
    newBoard = newBoard.filter((s) => s.length);
    const oldIds = new Set(oldBoard.flat());
    const rackIds = new Set(rack);
    const seen = new Set();
    const played = [];
    for (const set of newBoard) {
      for (const id of set) {
        if (!Number.isInteger(id) || seen.has(id)) return fail('Ongeldige of dubbele steen.');
        seen.add(id);
        if (oldIds.has(id)) continue;
        if (rackIds.has(id)) played.push(id);
        else return fail('Onbekende steen.');
      }
    }
    for (const id of oldIds) {
      if (!seen.has(id)) return fail('Stenen van het bord mogen niet terug naar je rek.');
    }
    if (!played.length) return fail('Leg minstens één steen uit je rek, of pak een steen.');

    const normalized = [];
    for (const set of newBoard) {
      const a = analyzeSet(set.map((id) => tiles[id]));
      if (!a) return fail('Niet alle reeksen op het bord zijn geldig.');
      normalized.push(a.tiles.map((t) => t.id));
    }

    let points = 0;
    if (!hasMelded) {
      const playedSet = new Set(played);
      const oldKeys = new Map();
      for (const s of oldBoard) {
        const k = setKey(s);
        oldKeys.set(k, (oldKeys.get(k) || 0) + 1);
      }
      for (const set of newBoard) {
        const fromRack = set.filter((id) => playedSet.has(id)).length;
        if (fromRack === 0) {
          const k = setKey(set);
          if (!oldKeys.get(k)) return fail('Je mag het bord pas aanpassen na je eerste uitleg.');
          oldKeys.set(k, oldKeys.get(k) - 1);
        } else if (fromRack !== set.length) {
          return fail('Voor je eerste uitleg mag je alleen je eigen stenen gebruiken.');
        } else {
          points += setPoints(set.map((id) => tiles[id]));
        }
      }
      if (points < MIN_INITIAL_MELD) {
        return fail(`Je eerste uitleg moet minstens ${MIN_INITIAL_MELD} punten zijn (nu ${points}).`);
      }
    }
    return { ok: true, board: normalized, played, points };
  }

  return {
    COLORS,
    JOKER_PENALTY,
    MIN_INITIAL_MELD,
    MAX_NUMBER,
    analyzeSet,
    setPoints,
    rackPenalty,
    validateMove,
  };
});
