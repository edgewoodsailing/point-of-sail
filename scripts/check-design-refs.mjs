#!/usr/bin/env node
/**
 * Keeps the design documents' bead references and cross-links honest.
 *
 * The document describes unbuilt design in the present tense, marked only by a
 * `(planned: pos-…)` reference — see its editing note. That works because the
 * document stops asserting status and points at the bead instead, which is the
 * one place status is current. What it owes in return is this: a way to notice
 * when a pointer's target has moved.
 *
 * So: **a reference to an open bead is load-bearing, and a reference to a
 * closed one is history.** When a bead closes, its paragraph has become a
 * description of the code and the parenthetical is now stale decoration, which
 * is how the document filled up with archaeology the first time.
 *
 * Four checks, all of them about drift rather than style:
 *
 * 1. Every reference resolves to a real bead. A typo is a dangling pointer.
 * 2. No reference to a closed bead, except the {@link BACKLOG} below.
 * 3. Every BACKLOG entry is still referenced and still closed, so the list can
 *    only shrink and cannot rot into a list of things that are no longer true.
 * 4. Every section link resolves to a heading that exists — within a document
 *    and **across** them. That check arrived with MODEL.md and is the reason to
 *    have it: one document could be checked by eye, and two cannot. Splitting
 *    mechanism out of DESIGN moved a dozen links onto a seam where renaming a
 *    heading breaks a file that was never opened.
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
const DOCUMENTS = ["DESIGN.md", "MODEL.md"];

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

function citations(sources) {
  const found = new Map();
  for (const [document, text] of sources) {
    text.split("\n").forEach((line, index) => {
      for (const [, id] of line.matchAll(REFERENCE)) {
        if (!found.has(id)) found.set(id, `${document}:${index + 1}`);
      }
    });
  }
  return found;
}

/**
 * A heading's anchor, the way GitHub builds one: lowercased, punctuation
 * dropped, spaces hyphenated.
 */
function anchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function headings(text) {
  return new Set(
    [...text.matchAll(/^#{1,6}\s+(.*)$/gm)].map(([, heading]) => anchor(heading)),
  );
}

/** Every `](#anchor)` and `](Other.md#anchor)`, with the file it points into. */
function links(document, text) {
  const out = [];
  text.split("\n").forEach((line, index) => {
    for (const [, target, fragment] of line.matchAll(/\]\(([\w.]*\.md)?#([^)]+)\)/g)) {
      out.push({ from: `${document}:${index + 1}`, into: target ?? document, fragment });
    }
  });
  return out;
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

const sources = DOCUMENTS.map((document) => [document, readFileSync(join(ROOT, document), "utf8")]);
const cited = citations(sources);
const failures = [];

// Checks 3 (first half) and 4 need no `bd`, so they run even in CI.
for (const id of BACKLOG) {
  if (!cited.has(id)) {
    failures.push(
      `${id} is on the backlog in scripts/check-design-refs.mjs but is no longer cited in ` +
        `${DOCUMENTS.join(" or ")}. Delete it from BACKLOG — the list is the work that remains.`,
    );
  }
}

const anchorsBy = new Map(sources.map(([document, text]) => [document, headings(text)]));
for (const [document, text] of sources) {
  for (const { from, into, fragment } of links(document, text)) {
    const target = anchorsBy.get(into);
    if (target === undefined) {
      failures.push(`${from} links into ${into}, which is not one of ${DOCUMENTS.join(", ")}.`);
    } else if (!target.has(fragment)) {
      failures.push(`${from} links to ${into}#${fragment}, which is not a heading there.`);
    }
  }
}

const status = beadStatus();
if (status === null) {
  console.warn(
    `check-design-refs: \`bd\` is unavailable, so bead references were not checked ` +
      `against live bead state. Expected in CI, where the bead database is gitignored; if you ` +
      `see this locally, the beads database is not answering.`,
  );
} else {
  for (const [id, where] of cited) {
    const state = status.get(id);
    if (state === undefined) {
      failures.push(`${where} cites ${id}, which is not a bead. Typo, or renamed?`);
    } else if (state === "closed" && !BACKLOG.includes(id)) {
      failures.push(
        `${where} cites ${id}, which is closed. A closed bead is history: state what ` +
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
  console.error(`check-design-refs: ${failures.length} problem(s) in ${DOCUMENTS.join(", ")}\n`);
  for (const failure of failures) console.error(`  • ${failure}`);
  process.exit(1);
}

const remaining = BACKLOG.filter((id) => cited.has(id)).length;
console.log(
  `check-design-refs: ${cited.size} bead reference(s) across ${DOCUMENTS.join(", ")}` +
    (remaining > 0 ? `, ${remaining} still to clear from the editorial backlog.` : ". Backlog clear."),
);
