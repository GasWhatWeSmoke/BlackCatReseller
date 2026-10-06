"use strict";

/**
 * Parse the canonical Windows command line emitted by Node's spawn quoting.
 * Identity checks below also require byte-for-byte canonical reserialization,
 * so alternative or ambiguous quote forms fail closed.
 *
 * @param {unknown} value
 * @returns {string[] | null}
 */
function parseWindowsCommandLine(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32 * 1024 ||
      value.includes("\0") || /^[\t ]/.test(value)) {
    return null;
  }

  const argv = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === " " || value[index] === "\t") index += 1;
    if (index >= value.length) break;

    let argument = "";
    let quoted = false;
    while (index < value.length) {
      let backslashes = 0;
      while (value[index] === "\\") {
        backslashes += 1;
        index += 1;
      }

      if (value[index] === '"') {
        argument += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          argument += '"';
        } else {
          quoted = !quoted;
        }
        index += 1;
        continue;
      }

      argument += "\\".repeat(backslashes);
      if (index >= value.length || (!quoted && (value[index] === " " || value[index] === "\t"))) {
        break;
      }
      argument += value[index];
      index += 1;
    }
    argv.push(argument);
  }
  return argv.length > 0 ? argv : null;
}

/** @param {string} value @returns {string} */
function quoteWindowsArgument(value) {
  if (value.length > 0 && !/[\t "]/.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      quoted += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

/** @param {readonly string[]} argv @returns {string} */
function serializeWindowsCommandLine(argv) {
  return argv.map(quoteWindowsArgument).join(" ");
}

/**
 * @param {unknown} commandLine
 * @param {readonly string[]} expectedArgv
 * @returns {boolean}
 */
function commandLineHasExactArgv(commandLine, expectedArgv) {
  if (!Array.isArray(expectedArgv) || expectedArgv.some((value) => typeof value !== "string")) {
    return false;
  }
  if (commandLine !== serializeWindowsCommandLine(expectedArgv)) return false;
  const actual = parseWindowsCommandLine(commandLine);
  return actual !== null && actual.length === expectedArgv.length &&
    actual.every((value, index) => value === expectedArgv[index]);
}

module.exports = {
  commandLineHasExactArgv,
  parseWindowsCommandLine,
  quoteWindowsArgument,
  serializeWindowsCommandLine,
};
