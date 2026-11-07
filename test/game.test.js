const test = require("node:test");
const assert = require("node:assert");
const Rules = require("../public/rules.js");
const { Game, createTiles } = require("../server/game.js");
const { chooseBotMove } = require("../server/bot.js");

const t = (color, number) => ({ color, number, joker: false });
const J = { color: "joker", number: 0, joker: true };

test("runs and groups", () => {
  assert.ok(Rules.analyzeSet([t("red", 3), t("red", 4), t("red", 5)]));
  assert.ok(
    Rules.analyzeSet([
      t("red", 7),
      t("blue", 7),
      t("black", 7),
      t("orange", 7),
    ]),
  );
  assert.equal(
    Rules.analyzeSet([t("red", 7), t("red", 7), t("black", 7)]),
    null,
  );
  assert.equal(
    Rules.analyzeSet([t("red", 12), t("red", 13), t("red", 1)]),
    null,
  );
  assert.equal(
    Rules.analyzeSet([t("red", 3), t("blue", 4), t("red", 5)]),
    null,
  );
  assert.equal(Rules.analyzeSet([t("red", 3), t("red", 4)]), null);
});

test("jokers take the value of their position", () => {
  assert.deepEqual(
    Rules.analyzeSet([t("red", 3), J, t("red", 5)]).values,
    [3, 4, 5],
  );
  assert.deepEqual(
    Rules.analyzeSet([J, t("red", 12), t("red", 13)]).values,
    [11, 12, 13],
  );
  assert.deepEqual(
    Rules.analyzeSet([t("red", 12), t("red", 13), J]).values,
    [11, 12, 13],
  );
  assert.deepEqual(
    Rules.analyzeSet([t("blue", 9), J, t("red", 9)]).values,
    [9, 9, 9],
  );
  assert.equal(Rules.setPoints([t("red", 10), t("red", 11), J]), 33);
});

test("unordered run is rearranged", () => {
  const a = Rules.analyzeSet([t("blue", 6), t("blue", 4), t("blue", 5)]);
  assert.deepEqual(a.values, [4, 5, 6]);
});

test("initial meld must be >= 30 with own tiles only", () => {
  const tiles = createTiles();
  const id = (color, n) =>
    tiles.find((x) => x.color === color && x.number === n).id;
  const rack = [
    id("red", 10),
    id("red", 11),
    id("red", 12),
    id("blue", 1),
    id("blue", 2),
    id("blue", 3),
  ];
  const ok = Rules.validateMove({
    oldBoard: [],
    newBoard: [rack.slice(0, 3)],
    rack,
    tiles,
    hasMelded: false,
  });
  assert.ok(ok.ok);
  assert.equal(ok.points, 33);
  const low = Rules.validateMove({
    oldBoard: [],
    newBoard: [rack.slice(3)],
    rack,
    tiles,
    hasMelded: false,
  });
  assert.equal(low.ok, false);

  const board = [[id("black", 5), id("black", 6), id("black", 7)]];
  const r2 = [id("black", 8), ...rack.slice(0, 3)];
  const extend = Rules.validateMove({
    oldBoard: board,
    newBoard: [[...board[0], r2[0]], rack.slice(0, 3)],
    rack: r2,
    tiles,
    hasMelded: false,
  });
  assert.equal(extend.ok, false);
  const extendAfterMeld = Rules.validateMove({
    oldBoard: board,
    newBoard: [[...board[0], r2[0]]],
    rack: r2,
    tiles,
    hasMelded: true,
  });
  assert.ok(extendAfterMeld.ok);
});

test("board tiles cannot be taken back", () => {
  const tiles = createTiles();
  const res = Rules.validateMove({
    oldBoard: [[0, 1, 2]],
    newBoard: [[3, 4, 5]],
    rack: [3, 4, 5],
    tiles,
    hasMelded: true,
  });
  assert.match(res.error, /niet terug naar je rek/);
});

test("bots can play complete games without invalid moves", () => {
  for (let round = 0; round < 30; round++) {
    const game = new Game(["a", "b", "c", "d"]);
    let turns = 0;
    while (!game.finished) {
      const move = chooseBotMove(game);
      const pid = game.currentPlayer.id;
      if (move.type === "play") {
        const res = game.play(pid, move.board);
        assert.ok(res.ok, res.error);
      } else {
        assert.ok(game.draw(pid).ok);
      }
      assert.ok(++turns < 2000, "game should end");
    }
    const total =
      game.board.flat().length +
      game.pool.length +
      game.players.reduce((s, p) => s + p.rack.length, 0);
    assert.equal(total, 106);
    assert.equal(
      game.result.players.reduce((s, p) => s + p.roundScore, 0),
      0,
    );
  }
});
