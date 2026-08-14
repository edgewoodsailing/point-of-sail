#!/usr/bin/env node
/**
 * Keeps DESIGN.md's bead references honest.
 *
 * The document describes unbuilt design in the present tense, marked only by a
 * `(planned: pos-xxx)` reference — see its editing note. That works because the
 * document stops asserting status and points at the bead instead, which is the
 * one place status is current. What it owes in return is this: a way to notice
 * when a pointer's target has moved.
 *
 * So: **a reference to an open bead is load-bearing, and a reference to a
 * closed one is history.** When a bead closes, its paragraph has become a
 * description of the code and the parenthetical is now stale decoration, which
 * is how the document filled up with archaeology the first time.
 *
 * Three checks, all of them about drift rather than style:
 *
 * 1. Every reference resolves to a real bead. A typo is a dangling pointer.
 * 2. No reference to a closed bead, except the {@link BACKLOG} below.
 * 3. Every BACKLOG entry is still referenced and still closed, so the list can
 *    only shrink and cannot rot into a list of things that are no longer true.
 *
 * Not a vitest test, though it looks like one, and the reason is in
 * `tsconfig.json`: the project carries no Node typings (`"types":
 * ["vite/client"]`), and `no-raw-trig.test.ts` says in as many words that the
 * suite reads sources through Vite's glob to keep it that way. Asking an
 * external tool for live state needs `child_process`, so this runs from `lint`
 * instead — which is where "does the repository obey its own conventions" already
 * lives.
 *
 * Skips, loudly, wherever `bd` cannot be reached: the bead database is
 * gitignored, so CI has no bead state and this can only run where the editing
 * happens. Check 3's "still referenced" half needs no `bd` and runs regardless.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCUMENT = "DESIGN.md";

/**
 * Closed beads DESIGN.md still cites, as of the editorial pass that introduced
 * this check. **A worklist, not an allowlist.** Each is a paragraph explaining
 * the design in terms of what it used to be; the fix is to state what is true
 * now and delete the reference, not to add entries here.
 *
 * Check 3 fails on any entry that is no longer cited, so removing a citation
 * without removing it here is caught, and the list is always exactly the work
 * that remains.
 */
const BACKLOG = [
  "pos-32n",
  "pos-770",
  "pos-8pu",
  "pos-aa2",
  "pos-aax",
  "pos-bql",
  "pos-d7u",
  "pos-dmg.2",
  "pos-fo1",
  "pos-fo1.4",
  "pos-i4o",
  "pos-lcz",
  "pos-qmk",
  "pos-rem",
  "pos-t9w",
];

/**
 * Bead IDs, but not CSS.
 *
 * `--pos-rule-speed` and `.pos-sim` are all over this document and match a
 * naive `pos-\w+`; the lookbehind drops them by requiring the reference to
 * start a word rather than continue one. Measured against the document when
 * this was written: 21 references, every one a real bead, no false positives.
 */
const REFERENCE = /(?<![-.\w])(pos-[a-z0-9]+(?:\.\d+)*)/g;

function citations(text) {
  const found = new Map();
  text.split("\n").forEach((line, index) => {
    for (const [, id] of line.matchAll(REFERENCE)) {
      if (!found.has(id)) found.set(id, index + 1);
    }
  });
  return found;
}

/** Every bead's status, or null when `bd` cannot answer. */
function beadStatus() {
  try {
    const raw = execFileSync("bd", ["list", "--status=all", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Map(JSON.parse(raw).map((issue) => [issue.id, issue.status]));
  } catch {
    return null;
  }
}

const text = readFileSync(join(ROOT, DOCUMENT), "utf8");
const cited = citations(text);
const failures = [];

// Check 3, first half: needs no `bd`, so it runs even in CI.
for (const id of BACKLOG) {
  if (!cited.has(id)) {
    failures.push(
      `${id} is on the backlog in scripts/check-design-refs.mjs but is no longer cited in ` +
        `${DOCUMENT}. Delete it from BACKLOG — the list is the work that remains.`,
    );
  }
}

const status = beadStatus();
if (status === null) {
  console.warn(
    `check-design-refs: \`bd\` is unavailable, so ${DOCUMENT}'s references were not checked ` +
      `against live bead state. Expected in CI, where the bead database is gitignored; if you ` +
      `see this locally, the beads database is not answering.`,
  );
} else {
  for (const [id, line] of cited) {
    const state = status.get(id);
    if (state === undefined) {
      failures.push(`${DOCUMENT}:${line} cites ${id}, which is not a bead. Typo, or renamed?`);
    } else if (state === "closed" && !BACKLOG.includes(id)) {
      failures.push(
        `${DOCUMENT}:${line} cites ${id}, which is closed. A closed bead is history: state what ` +
          `is true now and drop the reference. The archaeology is in the commit and the bead.`,
      );
    }
  }
  for (const id of BACKLOG) {
    if (cited.has(id) && status.get(id) !== "closed") {
      failures.push(
        `${id} is on the backlog but is ${status.get(id) ?? "missing"}, not closed. If it was ` +
          `reopened the citation may be load-bearing again — take it off the list.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`check-design-refs: ${failures.length} problem(s) in ${DOCUMENT}\n`);
  for (const failure of failures) console.error(`  • ${failure}`);
  process.exit(1);
}

const remaining = BACKLOG.filter((id) => cited.has(id)).length;
console.log(
  `check-design-refs: ${cited.size} bead reference(s) in ${DOCUMENT}` +
    (remaining > 0 ? `, ${remaining} still to clear from the editorial backlog.` : ". Backlog clear."),
);
