// Loads the browser-shared game files (plain scripts, not modules) into a
// single function scope and exports the pieces the server needs.
// The same files are loaded via <script> tags in the browser — one source
// of truth for rules, evaluation, CPU strategy and the engine.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['js/constants.js', 'js/cards.js', 'js/cpu.js', 'js/engine.js'];

const src = FILES.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n')
  + '\nreturn { createEngine, CPU_CHARS, PERSONALITIES, STARTING_STACK, shuffle };';

module.exports = new Function(src)();
