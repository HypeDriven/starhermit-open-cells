/*
 * Open Cells — semantic DOM board.
 * A fully playable HTML representation of the same logical state the 3D
 * canvas renders. It serves keyboard and screen-reader users always, and
 * becomes the primary visible interface when WebGL is unavailable or the
 * player chooses HTML mode. Cards and slots are real buttons with real
 * focus; nothing here depends on hover.
 * Browser only. Exposes window.OCBoardDom.
 */
(function (global) {
  'use strict';

  var R = global.OCRules;
  var SUIT_WORDS = ['spades', 'hearts', 'diamonds', 'clubs'];
  var RANK_WORDS = ['ace', 'two', 'three', 'four', 'five', 'six', 'seven',
    'eight', 'nine', 'ten', 'jack', 'queen', 'king'];

  function cardWords(id) {
    return RANK_WORDS[R.rankOf(id) - 1] + ' of ' + SUIT_WORDS[R.suitOf(id)];
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // container: element to render into.
  // hooks: { onCard(loc, depth), onSlot(loc), onKeyNav(event) -> bool handled }
  function createBoard(container, hooks) {
    var state = null;
    var selection = null;      // { loc, count }
    var legalTargets = [];     // array of loc
    var hintLocs = [];         // [fromLoc, toLoc] when a hint is shown

    container.classList.add('dom-board');
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Card table');

    var topRow = el('div', 'dom-top');
    var cellsSec = el('section', 'dom-cells');
    cellsSec.setAttribute('aria-label', 'Temporary cells');
    var cellsHead = el('h3', 'visually-hidden', 'Temporary cells');
    cellsSec.appendChild(cellsHead);
    var foundSec = el('section', 'dom-foundations');
    foundSec.setAttribute('aria-label', 'Foundations');
    foundSec.appendChild(el('h3', 'visually-hidden', 'Foundations'));
    topRow.appendChild(cellsSec);
    topRow.appendChild(foundSec);

    var tableauSec = el('section', 'dom-tableau');
    tableauSec.setAttribute('aria-label', 'Tableau');
    tableauSec.appendChild(el('h3', 'visually-hidden', 'Tableau'));

    container.appendChild(topRow);
    container.appendChild(tableauSec);

    function locKey(loc) { return loc.zone + '-' + loc.index; }

    function isLegalTarget(loc) {
      return legalTargets.some(function (l) { return l.zone === loc.zone && l.index === loc.index; });
    }
    function isHintLoc(loc) {
      return hintLocs.some(function (l) { return l && l.zone === loc.zone && l.index === loc.index; });
    }
    function isSelected(loc) {
      return selection && selection.loc.zone === loc.zone && selection.loc.index === loc.index;
    }

    function makeSlotButton(loc, ariaLabel, extraCls, shortText) {
      var b = el('button', 'slot ' + (extraCls || ''), shortText != null ? shortText : ariaLabel);
      b.type = 'button';
      b.dataset.loc = locKey(loc);
      b.setAttribute('aria-label', ariaLabel + (isLegalTarget(loc) ? ' — legal target' : ''));
      if (isLegalTarget(loc)) b.classList.add('legal-target');
      if (isHintLoc(loc)) b.classList.add('hint-target');
      b.addEventListener('click', function () { hooks.onSlot(loc); });
      return b;
    }

    function makeCardButton(id, loc, depth, total) {
      var b = el('button', 'card ' + (R.colorOf(id) === 'red' ? 'red' : 'black'));
      b.type = 'button';
      b.dataset.loc = locKey(loc);
      b.dataset.depth = depth;
      var rank = R.RANK_LABELS[R.rankOf(id) - 1];
      var sym = R.SUIT_SYMBOLS[R.suitOf(id)];
      b.innerHTML = '<span class="card-rank"></span> <span class="card-suit"></span>';
      b.querySelector('.card-rank').textContent = rank;
      b.querySelector('.card-suit').textContent = sym;
      var where = loc.zone === 'tableau'
        ? 'column ' + (loc.index + 1) + ', card ' + (depth + 1) + ' of ' + total
        : loc.zone === 'cell' ? 'cell ' + (loc.index + 1) : SUIT_WORDS[loc.index] + ' foundation';
      b.setAttribute('aria-label', cardWords(id) + ', ' + where);
      if (isSelected(loc) && (loc.zone !== 'tableau' || depth >= total - (selection.count || 1))) b.classList.add('selected');
      if (isLegalTarget(loc) && depth === total - 1) b.classList.add('legal-target');
      if (isHintLoc(loc) && depth === total - 1) b.classList.add('hint-target');
      b.addEventListener('click', function () { hooks.onCard(loc, depth); });
      return b;
    }

    function render(newState, sel, targets, hint) {
      state = newState;
      selection = sel;
      legalTargets = targets || [];
      hintLocs = hint ? [hint.from, hint.to] : [];

      // Cells.
      cellsSec.querySelectorAll('.slot, .card').forEach(function (n) { n.remove(); });
      for (var i = 0; i < R.NUM_CELLS; i++) {
        var available = i < state.constraints.cellsAvailable;
        var id = state.cells[i];
        if (!available) {
          var dis = el('div', 'slot disabled', '—');
          dis.setAttribute('aria-hidden', 'true');
          cellsSec.appendChild(dis);
        } else if (id === null) {
          cellsSec.appendChild(makeSlotButton({ zone: 'cell', index: i }, 'Empty cell ' + (i + 1), null, 'Cell ' + (i + 1)));
        } else {
          cellsSec.appendChild(makeCardButton(id, { zone: 'cell', index: i }, 0, 1));
        }
      }

      // Foundations.
      foundSec.querySelectorAll('.slot, .card').forEach(function (n) { n.remove(); });
      for (var f = 0; f < R.NUM_SUITS; f++) {
        var pile = state.foundations[f];
        if (pile.length === 0) {
          foundSec.appendChild(makeSlotButton({ zone: 'foundation', index: f },
            SUIT_WORDS[f] + ' foundation, empty', null, R.SUIT_SYMBOLS[f]));
        } else {
          var top = pile[pile.length - 1];
          foundSec.appendChild(makeCardButton(top, { zone: 'foundation', index: f }, pile.length - 1, pile.length));
        }
      }

      // Tableau.
      tableauSec.querySelectorAll('.dom-column').forEach(function (n) { n.remove(); });
      for (var c = 0; c < R.NUM_COLUMNS; c++) {
        var colEl = el('div', 'dom-column');
        colEl.setAttribute('role', 'group');
        colEl.setAttribute('aria-label', 'Column ' + (c + 1) + (state.tableau[c].length ? '' : ', empty'));
        if (state.tableau[c].length === 0) {
          colEl.appendChild(makeSlotButton({ zone: 'tableau', index: c }, 'Empty column ' + (c + 1), 'column-slot'));
        } else {
          for (var d = 0; d < state.tableau[c].length; d++) {
            colEl.appendChild(makeCardButton(state.tableau[c][d], { zone: 'tableau', index: c }, d, state.tableau[c].length));
          }
        }
        tableauSec.appendChild(colEl);
      }
    }

    // Arrow-key navigation across the logical grid (keyboard: directional
    // navigation among targets, spec §3). Native Tab still works everywhere.
    container.addEventListener('keydown', function (ev) {
      var cur = document.activeElement;
      if (!cur || !container.contains(cur) || !(cur.dataset && cur.dataset.loc)) return;
      var parts = cur.dataset.loc.split('-');
      var zone = parts[0], index = parseInt(parts[1], 10);
      var depth = cur.dataset.depth ? parseInt(cur.dataset.depth, 10) : 0;
      var next = null;
      // Arrow equivalent of the pressed key (player rebinds via hooks.navKey).
      var key = hooks.navKey ? hooks.navKey(ev) : ev.key;

      function firstCardIn(zoneName, idx) {
        return container.querySelector('[data-loc="' + zoneName + '-' + idx + '"]');
      }

      if (key === 'ArrowRight' || key === 'ArrowLeft') {
        var dir = key === 'ArrowRight' ? 1 : -1;
        if (zone === 'tableau') {
          next = firstCardIn('tableau', (index + dir + R.NUM_COLUMNS) % R.NUM_COLUMNS);
        } else if (zone === 'cell') {
          next = dir > 0 ? (firstCardIn('cell', index + 1) || firstCardIn('foundation', 3)) : firstCardIn('cell', index - 1);
        } else if (zone === 'foundation') {
          next = dir > 0 ? firstCardIn('foundation', index - 1) : (firstCardIn('foundation', index + 1) || firstCardIn('cell', 3));
        }
        // Fallback into the tableau when leaving the top row.
        if (!next && zone !== 'tableau') next = firstCardIn('tableau', Math.min(index, R.NUM_COLUMNS - 1));
      } else if (key === 'ArrowDown' || key === 'ArrowUp') {
        var dd = key === 'ArrowDown' ? 1 : -1;
        if (zone === 'tableau') {
          var colLen = state ? state.tableau[index].length : 0;
          var nd = depth + dd;
          if (dd < 0 && depth === 0) {
            // Up out of a column: to the matching top-row slot.
            next = firstCardIn(index < 4 ? 'cell' : 'foundation', index < 4 ? index : 7 - index);
          } else if (nd >= 0 && nd < colLen) {
            next = container.querySelector('[data-loc="tableau-' + index + '"][data-depth="' + nd + '"]');
          }
        } else {
          // Down from top row into the tableau.
          next = firstCardIn('tableau', zone === 'cell' ? index : 7 - index);
        }
      }
      if (next) {
        ev.preventDefault();
        next.focus();
      } else if (hooks.onKeyNav && hooks.onKeyNav(ev)) {
        ev.preventDefault();
      }
    });

    return {
      render: render,
      focusFirst: function () {
        var b = container.querySelector('button');
        if (b) b.focus();
      },
      setVisible: function (v) { container.classList.toggle('dom-board-hidden', !v); }
    };
  }

  global.OCBoardDom = { createBoard: createBoard, cardWords: cardWords };
})(typeof self !== 'undefined' ? self : this);
