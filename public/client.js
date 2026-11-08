(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = "rummikub-session";
  const NAME_KEY = "rummikub-name";
  const COLOR_ORDER = { red: 0, blue: 1, orange: 2, black: 3, joker: 4 };

  const S = {
    session: loadSession(),
    room: null,
    tiles: new Map(),
    board: [], // working copy: arrays of tile ids
    rack: [], // tile ids in local display order
    turnStartRack: new Set(),
    turnKey: null,
    round: null,
    newDraws: new Set(),
    preview: null,
    resultDismissed: null,
    deadline: null,
  };

  // ---------- session ----------

  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY));
    } catch {
      return null;
    }
  }
  function saveSession(s) {
    S.session = s;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }
  function clearSession() {
    S.session = null;
    sessionStorage.removeItem(SESSION_KEY);
  }

  // ---------- helpers ----------

  const game = () => S.room && S.room.game;
  const me = () => S.room && S.room.you;
  const isMyTurn = () => {
    const g = game();
    return !!g && !g.finished && g.currentPlayerId === me();
  };
  const inGame = () => {
    const g = game();
    return !!g && g.players.some((p) => p.id === me());
  };
  const roomPlayer = (id) => S.room.players.find((p) => p.id === id);
  const tile = (id) => S.tiles.get(id);
  const isFresh = (id) => S.turnStartRack.has(id);
  const placedIds = () => S.board.flat().filter(isFresh);

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  let toastTimer;
  function toast(text, isError = false) {
    const t = $("toast");
    t.textContent = text;
    t.className = isError ? "err" : "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
  }

  function showScreen(name) {
    $("screen-home").classList.toggle("hidden", name !== "home");
    $("screen-room").classList.toggle("hidden", name !== "room");
    if (name === "home") $("result").classList.add("hidden");
  }

  function goHome() {
    clearSession();
    S.room = null;
    S.turnKey = null;
    showScreen("home");
    history.replaceState(null, "", "/");
  }

  // ---------- home ----------

  $("name").value = localStorage.getItem(NAME_KEY) || "";
  const urlRoom = new URLSearchParams(location.search).get("room");
  if (urlRoom) $("code").value = urlRoom.toUpperCase();

  function getName() {
    const name = $("name").value.trim();
    if (!name) {
      $("home-error").textContent = "Vul eerst je naam in.";
      $("name").focus();
      return null;
    }
    localStorage.setItem(NAME_KEY, name);
    return name;
  }

  function onJoined(res) {
    if (!res.ok) {
      $("home-error").textContent = res.error;
      return;
    }
    $("home-error").textContent = "";
    saveSession({ code: res.code, token: res.token });
    history.replaceState(null, "", `/?room=${res.code}`);
  }

  $("btn-create").onclick = () => {
    const name = getName();
    if (name) socket.emit("createRoom", { name }, onJoined);
  };
  $("btn-join").onclick = () => {
    const name = getName();
    const code = $("code").value.trim().toUpperCase();
    if (!name) return;
    if (code.length !== 5) {
      $("home-error").textContent = "Vul een geldige code van 5 tekens in.";
      return;
    }
    socket.emit("joinRoom", { code, name }, onJoined);
  };
  $("code").addEventListener(
    "keydown",
    (e) => e.key === "Enter" && $("btn-join").click(),
  );
  $("name").addEventListener("keydown", (e) => {
    if (e.key === "Enter")
      ($("code").value.trim() ? $("btn-join") : $("btn-create")).click();
  });

  socket.on("connect", () => {
    if (!S.session) return;
    socket.emit(
      "joinRoom",
      { code: S.session.code, token: S.session.token },
      (res) => {
        if (!res.ok) {
          goHome();
          toast(res.error, true);
        }
      },
    );
  });

  socket.on("kicked", ({ reason }) => {
    goHome();
    toast(reason, true);
  });

  // ---------- room state ----------

  socket.on("room", (state) => {
    S.room = state;
    const g = state.game;
    if (g) syncGame(state, g);
    showScreen("room");
    render();
  });

  function syncGame(state, g) {
    for (const t of [...g.myRack, ...g.board.flat()]) S.tiles.set(t.id, t);
    const serverRack = g.myRack.map((t) => t.id);
    const key = `${state.round}:${g.turnNumber}:${g.finished}`;
    const newRound = state.round !== S.round;

    if (!(isMyTurn() && key === S.turnKey)) {
      S.board = g.board.map((set) => set.map((t) => t.id));
      if (newRound) {
        S.rack = sortIds(serverRack, "color");
        S.newDraws = new Set();
        S.resultDismissed = null;
      } else {
        const known = new Set(serverRack);
        const kept = S.rack.filter((id) => known.has(id));
        const keptSet = new Set(kept);
        const added = serverRack.filter((id) => !keptSet.has(id));
        S.rack = [...kept, ...added];
        if (added.length) S.newDraws = new Set(added);
      }
      S.turnStartRack = new Set(serverRack);
      if (key !== S.turnKey) S.preview = null;
    }
    S.turnKey = key;
    S.round = state.round;
    S.deadline =
      g.turnRemainingMs != null ? Date.now() + g.turnRemainingMs : null;
  }

  socket.on("preview", (data) => {
    const g = game();
    if (!g || isMyTurn() || data.turnNumber !== g.turnNumber) return;
    S.preview = data.board;
    renderBoard();
  });

  function sortIds(ids, mode) {
    return ids.slice().sort((a, b) => {
      const ta = tile(a);
      const tb = tile(b);
      if (ta.joker !== tb.joker) return ta.joker ? 1 : -1;
      if (mode === "number")
        return (
          ta.number - tb.number || COLOR_ORDER[ta.color] - COLOR_ORDER[tb.color]
        );
      return (
        COLOR_ORDER[ta.color] - COLOR_ORDER[tb.color] || ta.number - tb.number
      );
    });
  }

  // ---------- rendering ----------

  function render() {
    const g = game();
    $("lobby").classList.toggle("hidden", !!g);
    $("game").classList.toggle("hidden", !g);
    if (!g) return renderLobby();
    renderGame();
  }

  function renderLobby() {
    const r = S.room;
    const isHost = r.hostId === me();
    $("lobby-code").textContent = r.code;
    const list = $("lobby-players");
    list.replaceChildren();
    for (const p of r.players) {
      const li = el("li", p.connected ? "" : "offline");
      li.append(el("span", "name", p.name + (p.id === me() ? " (jij)" : "")));
      if (p.id === r.hostId) li.append(el("span", "badge host", "host"));
      if (p.isBot) li.append(el("span", "badge", "bot"));
      if (!p.connected) li.append(el("span", "badge", "offline"));
      if (isHost && p.id !== me()) {
        const rm = el("button", "small", "Verwijder");
        rm.onclick = () =>
          socket.emit(
            "removePlayer",
            { playerId: p.id },
            (res) => !res.ok && toast(res.error, true),
          );
        li.append(rm);
      }
      list.append(li);
    }
    for (let i = r.players.length; i < r.maxPlayers; i++)
      list.append(el("li", "offline", "Vrije plek"));

    $("host-controls").classList.toggle("hidden", !isHost);
    $("lobby-wait").classList.toggle("hidden", isHost);
    $("btn-add-bot").disabled = r.players.length >= r.maxPlayers;
    $("btn-start").disabled = r.players.length < 2;
    const sel = $("timer-select");
    if (sel.options.length !== r.timerOptions.length) {
      sel.replaceChildren(
        ...r.timerOptions.map(
          (s) => new Option(s ? `${s} seconden` : "Geen limiet", s),
        ),
      );
    }
    sel.value = r.settings.turnSeconds;
  }

  function renderGame() {
    renderPlayers();
    renderBoard();
    renderRack();
    renderControls();
    renderResult();
  }

  function renderPlayers() {
    const g = game();
    const bar = $("players-bar");
    bar.replaceChildren();
    for (const gp of g.players) {
      const p = roomPlayer(gp.id) || { name: "?", score: 0 };
      const chip = el("div", "pchip");
      if (!g.finished && gp.id === g.currentPlayerId)
        chip.classList.add("turn");
      if (gp.id === me()) chip.classList.add("me");
      if (p.connected === false) chip.classList.add("offline");
      chip.append(el("span", "pname", p.name));
      if (p.isBot) chip.append(el("span", "badge", "bot"));
      chip.append(el("span", "count", gp.rackCount));
      chip.title = gp.hasMelded ? "Heeft uitgelegd" : "Nog niet uitgelegd";
      chip.append(el("span", "score", `${p.score} pt`));
      if (!gp.hasMelded)
        chip.append(el("span", "score unmelded", "· nog niet uitgelegd"));
      bar.append(chip);
    }
    $("pool-count").textContent = `Pot: ${g.poolCount}`;
  }

  function tileEl(t) {
    const e = el(
      "div",
      `tile ${t.joker ? "joker" : t.color}`,
      t.joker ? "☺" : String(t.number),
    );
    e.dataset.id = t.id;
    return e;
  }

  function renderBoard() {
    const g = game();
    if (!g) return;
    const board = $("board");
    board.replaceChildren();
    const mine = isMyTurn();
    const preview = !mine && !g.finished && S.preview;
    let sets;
    if (mine) sets = S.board.map((ids) => ids.map(tile));
    else if (preview) sets = S.preview;
    else sets = g.board;
    const committed = new Set(g.board.flat().map((t) => t.id));

    sets.forEach((set, idx) => {
      const div = el("div", "set");
      div.dataset.index = idx;
      if (!Rules.analyzeSet(set)) div.classList.add("invalid");
      for (const t of set) {
        const te = tileEl(t);
        if (mine) {
          if (isFresh(t.id)) te.classList.add("fresh");
          if (g.hasMelded || isFresh(t.id)) te.classList.add("draggable");
        } else if (preview && !committed.has(t.id)) {
          te.classList.add("fresh");
        }
        div.append(te);
      }
      board.append(div);
    });

    if (mine)
      board.append(
        el(
          "div",
          "new-set",
          "Sleep hier een steen naartoe voor een nieuwe reeks",
        ),
      );
    if (preview) {
      const p = roomPlayer(g.currentPlayerId);
      board.append(
        el(
          "div",
          "preview-note",
          `${p ? p.name : "De speler"} is aan het schuiven…`,
        ),
      );
    }
    if (!sets.length && !mine)
      board.append(el("div", "preview-note", "Het bord is nog leeg."));
  }

  function renderRack() {
    const rack = $("rack");
    rack.replaceChildren();
    const g = game();
    if (!inGame()) {
      rack.append(
        el("div", "muted", "Je kijkt mee en doet mee vanaf de volgende ronde."),
      );
      return;
    }
    const onBoard = new Set(S.board.flat());
    for (const id of S.rack) {
      if (onBoard.has(id)) continue;
      const te = tileEl(tile(id));
      if (!g.finished) te.classList.add("draggable");
      if (S.newDraws.has(id)) te.classList.add("new-draw");
      rack.append(te);
    }
  }

  function renderControls() {
    const g = game();
    const mine = isMyTurn();
    const placed = mine ? placedIds().length : 0;
    $("btn-play").disabled = !mine || !placed;
    $("btn-draw").disabled = !mine;
    $("btn-draw").textContent = g.poolCount ? "Steen pakken" : "Passen";
    $("btn-draw").dataset.short = g.poolCount ? "Pak steen" : "Passen";
    $("btn-reset").disabled = !mine;
    $("btn-show-result").classList.toggle("hidden", !g.finished);
    for (const id of ["btn-play", "btn-draw", "btn-reset"])
      $(id).classList.toggle("hidden", g.finished);

    const line = $("status-line");
    line.classList.toggle("myturn", mine);
    if (g.finished) {
      line.textContent = "De ronde is voorbij.";
    } else if (!inGame()) {
      line.textContent = `${roomPlayer(g.currentPlayerId)?.name || "Iemand"} is aan de beurt.`;
    } else if (mine) {
      let text = "Jouw beurt! Sleep stenen naar het bord.";
      if (!g.hasMelded) {
        const pts = S.board
          .filter((set) => set.length && set.every(isFresh))
          .reduce((s, set) => s + Rules.setPoints(set.map(tile)), 0);
        text += ` Eerste uitleg: ${pts}/${Rules.MIN_INITIAL_MELD} punten.`;
      }
      if (S.board.some((set) => !Rules.analyzeSet(set.map(tile))))
        text += " Let op: er zijn ongeldige reeksen (rood).";
      line.textContent = text;
    } else {
      line.textContent = `${roomPlayer(g.currentPlayerId)?.name || "Iemand"} is aan de beurt.`;
    }
  }

  function renderResult() {
    const g = game();
    const overlay = $("result");
    if (!g.finished || S.resultDismissed === S.turnKey) {
      overlay.classList.add("hidden");
      return;
    }
    const r = g.result;
    const winner = roomPlayer(r.winnerId);
    $("result-title").textContent =
      r.winnerId === me()
        ? "Je hebt gewonnen!"
        : `${winner ? winner.name : "Iemand"} wint ronde ${S.room.round}!`;
    const tbody = $("result-table").querySelector("tbody");
    tbody.replaceChildren();
    for (const rp of r.players
      .slice()
      .sort((a, b) => b.roundScore - a.roundScore)) {
      const p = roomPlayer(rp.id);
      const tr = el("tr", rp.id === r.winnerId ? "winner" : "");
      tr.append(
        el("td", "", p ? p.name : "?"),
        el(
          "td",
          "num",
          rp.rack.length ? `${rp.rack.length} (${rp.penalty})` : "0",
        ),
        el(
          "td",
          "num",
          rp.roundScore > 0 ? `+${rp.roundScore}` : String(rp.roundScore),
        ),
        el("td", "num", p ? String(p.score) : "-"),
      );
      tbody.append(tr);
    }
    const isHost = S.room.hostId === me();
    $("btn-new-round").classList.toggle("hidden", !isHost);
    $("result-wait").classList.toggle("hidden", isHost);
    overlay.classList.remove("hidden");
  }

  // ---------- timer ----------

  setInterval(() => {
    const g = game();
    const label = $("turn-timer");
    const fill = $("timer-fill");
    if (!g || g.finished || !S.deadline) {
      label.textContent = "";
      fill.style.width = "0";
      return;
    }
    const remaining = Math.max(0, S.deadline - Date.now());
    const total = S.room.settings.turnSeconds * 1000 || 1;
    const secs = Math.ceil(remaining / 1000);
    const low = secs <= 10;
    label.textContent = `${secs}s`;
    label.classList.toggle("low", low);
    fill.classList.toggle("low", low);
    fill.style.width = `${Math.min(100, (remaining / total) * 100)}%`;
  }, 250);

  // ---------- local moves ----------

  function locate(id) {
    for (let s = 0; s < S.board.length; s++) {
      const i = S.board[s].indexOf(id);
      if (i >= 0) return { type: "board", set: s, index: i };
    }
    if (S.rack.includes(id)) return { type: "rack" };
    return null;
  }

  function insertIndex(container, x, y, dragId, rowOnly) {
    const kids = [...container.querySelectorAll(":scope > .tile")].filter(
      (e) => Number(e.dataset.id) !== dragId,
    );
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect();
      if (rowOnly) {
        if (x < r.left + r.width / 2) return i;
      } else {
        if (y < r.top) return i;
        if (y <= r.bottom && x < r.left + r.width / 2) return i;
      }
    }
    return kids.length;
  }

  function dropTile(id, x, y) {
    const g = game();
    const from = locate(id);
    const target = document.elementFromPoint(x, y);
    if (!g || g.finished || !from || !target) return render();

    const rackEl = target.closest("#rack");
    const setEl = target.closest(".set");
    const boardEl = target.closest("#board-wrap");

    if (rackEl) {
      if (from.type === "board" && !isFresh(id))
        return toast("Stenen van het bord mogen niet naar je rek.", true);
      // Rack DOM omits tiles that are on the board, so map the visual index back to S.rack.
      const onBoard = new Set(S.board.flat());
      const visible = S.rack.filter((r) => !onBoard.has(r) && r !== id);
      const idx = insertIndex(rackEl, x, y, id, false);
      if (from.type === "board") S.board[from.set].splice(from.index, 1);
      S.rack = S.rack.filter((r) => r !== id);
      const before = visible[idx];
      const pos = before === undefined ? S.rack.length : S.rack.indexOf(before);
      S.rack.splice(pos, 0, id);
    } else if (setEl || boardEl) {
      if (!isMyTurn()) return toast("Je bent niet aan de beurt.", true);
      if (setEl) {
        const si = Number(setEl.dataset.index);
        if (!g.hasMelded && S.board[si].some((t) => !isFresh(t))) {
          return toast(
            `Leg eerst ${Rules.MIN_INITIAL_MELD} punten uit voordat je bestaande reeksen aanpast.`,
            true,
          );
        }
        const idx = insertIndex(setEl, x, y, id, true);
        if (from.type === "board") S.board[from.set].splice(from.index, 1);
        S.board[si].splice(idx, 0, id);
      } else {
        if (from.type === "board") S.board[from.set].splice(from.index, 1);
        S.board.push([id]);
      }
      if (!S.rack.includes(id) && isFresh(id)) S.rack.push(id);
    } else {
      return render();
    }
    S.board = S.board.filter((set) => set.length);
    afterLocalChange();
  }

  function afterLocalChange() {
    if (isMyTurn()) socket.emit("preview", { board: S.board });
    renderGame();
  }

  // ---------- drag & drop (pointer events: mouse + touch) ----------

  let drag = null;

  function clearDropTargets() {
    document
      .querySelectorAll(".drop-target")
      .forEach((e) => e.classList.remove("drop-target"));
  }

  function endDrag() {
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    drag.ghost?.remove();
    drag.el.classList.remove("dragging");
    clearDropTargets();
    drag = null;
  }

  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const t = e.target.closest(".tile.draggable");
    if (!t) return;
    e.preventDefault();
    const r = t.getBoundingClientRect();
    const touch = e.pointerType === "touch";
    drag = {
      id: Number(t.dataset.id),
      el: t,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      // On touch, show the tile above the finger so it stays visible.
      offX: touch ? r.width / 2 : e.clientX - r.left,
      offY: touch ? r.height + 12 : e.clientY - r.top,
      ghost: null,
      raf: 0,
    };
  });

  // Scroll the board while dragging near its top or bottom edge.
  function autoScroll() {
    if (!drag) return;
    const wrap = $("board-wrap");
    const r = wrap.getBoundingClientRect();
    const edge = 36;
    if (drag.x >= r.left && drag.x <= r.right) {
      if (drag.y >= r.top && drag.y < r.top + edge) wrap.scrollTop -= 8;
      else if (drag.y <= r.bottom && drag.y > r.bottom - edge)
        wrap.scrollTop += 8;
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
      drag.ghost = drag.el.cloneNode(true);
      drag.ghost.classList.add("ghost");
      drag.ghost.classList.remove("draggable", "new-draw");
      const r = drag.el.getBoundingClientRect();
      drag.ghost.style.width = `${r.width}px`;
      drag.ghost.style.height = `${r.height}px`;
      drag.ghost.style.fontSize = getComputedStyle(drag.el).fontSize;
      document.body.append(drag.ghost);
      drag.el.classList.add("dragging");
      drag.raf = requestAnimationFrame(autoScroll);
    }
    drag.ghost.style.left = `${e.clientX - drag.offX}px`;
    drag.ghost.style.top = `${e.clientY - drag.offY}px`;
    clearDropTargets();
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const zone =
      under &&
      (under.closest(".set, .new-set, #rack") ||
        (isMyTurn() &&
          under.closest("#board-wrap") &&
          $("board").querySelector(".new-set")));
    if (zone) zone.classList.add("drop-target");
  });

  document.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const { id, ghost } = drag;
    endDrag();
    if (ghost) dropTile(id, e.clientX, e.clientY);
  });
  document.addEventListener("pointercancel", endDrag);

  // ---------- buttons ----------

  $("btn-play").onclick = () => {
    socket.emit("play", { board: S.board }, (res) => {
      if (!res.ok) toast(res.error, true);
    });
  };

  $("btn-draw").onclick = () => {
    socket.emit("draw", {}, (res) => !res.ok && toast(res.error, true));
  };

  $("btn-reset").onclick = () => {
    const g = game();
    S.board = g.board.map((set) => set.map((t) => t.id));
    for (const id of S.turnStartRack) if (!S.rack.includes(id)) S.rack.push(id);
    afterLocalChange();
  };

  $("btn-sort-num").onclick = () => {
    S.rack = sortIds(S.rack, "number");
    renderRack();
  };
  $("btn-sort-color").onclick = () => {
    S.rack = sortIds(S.rack, "color");
    renderRack();
  };

  function leave() {
    const g = game();
    if (
      g &&
      !g.finished &&
      inGame() &&
      !confirm(
        "Weet je zeker dat je het spel wilt verlaten? Een bot neemt je plek over.",
      )
    )
      return;
    socket.emit("leaveRoom");
    goHome();
  }
  $("btn-leave-lobby").onclick = leave;
  $("btn-leave-game").onclick = leave;

  // ---------- fullscreen ----------

  const root = document.documentElement;
  const requestFs = root.requestFullscreen || root.webkitRequestFullscreen;
  const exitFs = document.exitFullscreen || document.webkitExitFullscreen;
  const isFullscreen = () =>
    !!(document.fullscreenElement || document.webkitFullscreenElement);

  function updateFullscreenButtons() {
    for (const b of document.querySelectorAll(".btn-fullscreen")) {
      b.classList.toggle("hidden", !requestFs);
      b.textContent = isFullscreen()
        ? "Volledig scherm uit"
        : "Volledig scherm";
      b.dataset.short = "⤢";
      b.title = b.textContent;
    }
  }

  async function toggleFullscreen() {
    try {
      if (isFullscreen()) return await exitFs.call(document);
      await requestFs.call(root);
      // Orientation lock only works in fullscreen and isn't supported everywhere (e.g. iOS).
      screen.orientation?.lock?.("landscape")?.catch(() => {});
    } catch {
      toast("Volledig scherm wordt niet ondersteund in deze browser.", true);
    }
  }

  for (const b of document.querySelectorAll(".btn-fullscreen")) {
    b.onclick = toggleFullscreen;
  }
  document.addEventListener("fullscreenchange", updateFullscreenButtons);
  document.addEventListener("webkitfullscreenchange", updateFullscreenButtons);
  updateFullscreenButtons();

  $("btn-copy").onclick = async () => {
    const link = `${location.origin}/?room=${S.room.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast("Uitnodigingslink gekopieerd!");
    } catch {
      prompt("Kopieer deze link:", link);
    }
  };

  $("btn-add-bot").onclick = () =>
    socket.emit("addBot", {}, (res) => !res.ok && toast(res.error, true));
  $("timer-select").onchange = (e) =>
    socket.emit("setTimer", { seconds: Number(e.target.value) });
  $("btn-start").onclick = () =>
    socket.emit("startGame", {}, (res) => {
      $("lobby-error").textContent = res.ok ? "" : res.error;
    });
  $("btn-new-round").onclick = () =>
    socket.emit("newRound", {}, (res) => !res.ok && toast(res.error, true));
  $("btn-view-board").onclick = () => {
    S.resultDismissed = S.turnKey;
    $("result").classList.add("hidden");
  };
  $("btn-show-result").onclick = () => {
    S.resultDismissed = null;
    renderResult();
  };

  // ---------- chat ----------

  function chatLine(msg) {
    const line = el("div", `msg ${msg.type}`);
    if (msg.type === "system") line.textContent = msg.text;
    else
      line.append(
        el("span", "who", `${msg.name}:`),
        document.createTextNode(msg.text),
      );
    return line;
  }

  function appendChat(msgs, replace) {
    const log = $("chat-log");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (replace) log.replaceChildren();
    log.append(...msgs.map(chatLine));
    if (atBottom || replace) log.scrollTop = log.scrollHeight;
  }

  socket.on("chatHistory", (msgs) => appendChat(msgs, true));
  socket.on("chat", (msg) => {
    appendChat([msg], false);
    const drawer = matchMedia(
      "(max-width: 800px), (max-height: 500px)",
    ).matches;
    if (drawer && !chatOpen() && msg.type === "chat" && msg.playerId !== me()) {
      unread++;
      updateUnread();
    }
  });

  let unread = 0;
  const chatOpen = () => document.body.classList.contains("chat-open");
  function updateUnread() {
    $("chat-unread").textContent = unread;
    $("chat-unread").classList.toggle("hidden", !unread);
  }
  function setChatOpen(open) {
    document.body.classList.toggle("chat-open", open);
    if (!open) return;
    unread = 0;
    updateUnread();
    $("chat-log").scrollTop = $("chat-log").scrollHeight;
  }
  $("btn-chat").onclick = () => setChatOpen(!chatOpen());
  $("btn-chat-close").onclick = () => setChatOpen(false);

  $("chat-form").onsubmit = (e) => {
    e.preventDefault();
    const input = $("chat-input");
    const text = input.value.trim();
    if (!text) return;
    socket.emit("chat", { text });
    input.value = "";
  };
})();
