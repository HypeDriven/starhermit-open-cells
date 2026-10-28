/* Open Cells — UK English (en-GB): only the strings whose spelling differs
 * from the US-English source text. */
(function (g) {
  var out = {
    'en-GB': {
      'Columns build downward in alternating colors.': 'Columns build downward in alternating colours.',
      'Eight columns build downward in alternating colors. Only ordered runs travel together.': 'Eight columns build downward in alternating colours. Only ordered runs travel together.',
      'Eight columns hold the whole deck, face up. Columns build downward in alternating colors.': 'Eight columns hold the whole deck, face up. Columns build downward in alternating colours.',
      'The six of spades can land on the seven of hearts — one rank lower, opposite color.': 'The six of spades can land on the seven of hearts — one rank lower, opposite colour.',
      'When every lower opposite-color card is home, a card is safe — the desk can collect such cards for you.': 'When every lower opposite-colour card is home, a card is safe — the desk can collect such cards for you.',
      'Suit color palette': 'Suit colour palette',
      'Clock synchronized with StarHermit.': 'Clock synchronised with StarHermit.',
    }
  };
  if (typeof module === 'object' && module.exports) module.exports = out;
  else Object.assign(g.OC_LOCALES = g.OC_LOCALES || {}, out);
})(typeof self !== 'undefined' ? self : globalThis);
