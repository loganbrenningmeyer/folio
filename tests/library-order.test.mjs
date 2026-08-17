import assert from "node:assert/strict";
import test from "node:test";
import {
  folderNames,
  isHiddenEntryName,
  parseFolderOrder,
  placedFolderNames,
  prunedOrder,
  renamedInOrder,
  serializeFolderOrder,
  sortFolderNotes,
  sortNotesByOrder,
  withFolderOrder,
} from "../app/library-order.js";

const pages = (...paths) => paths.map((path) => ({ path }));
const paths = (notes) => notes.map((note) => note.path);

test("an unreadable order file reads as no order at all", () => {
  assert.deepEqual(parseFolderOrder(undefined), {});
  assert.deepEqual(parseFolderOrder(""), {});
  assert.deepEqual(parseFolderOrder("{"), {});
  assert.deepEqual(parseFolderOrder("[]"), {});
  assert.deepEqual(parseFolderOrder('{"folders":"guides"}'), {});
});

test("the order file keeps only names a folder could hold", () => {
  const order = parseFolderOrder(
    JSON.stringify({
      version: 1,
      folders: {
        "": ["b.md", "", "a.md", "b.md", "nested/c.md", 7],
        guides: [],
        broken: "x.md",
      },
    }),
  );
  assert.deepEqual(order, { "": ["b.md", "a.md"] });
});

test("a written order reads back unchanged", () => {
  const order = { guides: ["b.md"], "": ["a.md", "z.md"] };
  assert.deepEqual(parseFolderOrder(serializeFolderOrder(order)), order);
  // Folders are written in a stable order so the file does not churn.
  assert.match(serializeFolderOrder(order), /"": \[[\s\S]*"guides": \[/);
});

test("pages the order file names come first, the rest naturally after", () => {
  const notes = pages("b.md", "a.md", "c.md", "10.md", "9.md");
  assert.deepEqual(paths(sortFolderNotes(notes, undefined)), [
    "9.md",
    "10.md",
    "a.md",
    "b.md",
    "c.md",
  ]);
  assert.deepEqual(paths(sortFolderNotes(notes, ["c.md", "b.md"])), [
    "c.md",
    "b.md",
    "9.md",
    "10.md",
    "a.md",
  ]);
});

test("a page renamed elsewhere still matches its recorded place", () => {
  const notes = pages("Setup.md", "intro.md");
  assert.deepEqual(paths(sortFolderNotes(notes, ["setup.md"])), [
    "Setup.md",
    "intro.md",
  ]);
});

test("each folder is ordered on its own, folders stay natural", () => {
  const notes = pages("guides/b.md", "intro.md", "guides/a.md", "appendix.md");
  const order = { "": ["intro.md"], guides: ["guides/a.md"] };
  // Names are file names, not paths: a path spelled out matches nothing.
  assert.deepEqual(paths(sortNotesByOrder(notes, order)), [
    "intro.md",
    "appendix.md",
    "guides/a.md",
    "guides/b.md",
  ]);
  assert.deepEqual(paths(sortNotesByOrder(notes, { guides: ["b.md"] })), [
    "appendix.md",
    "intro.md",
    "guides/b.md",
    "guides/a.md",
  ]);
});

test("a folder's listed names follow the order it records", () => {
  const notes = pages("guides/b.md", "guides/a.md", "intro.md");
  assert.deepEqual(folderNames(notes, "guides", { guides: ["b.md"] }), [
    "b.md",
    "a.md",
  ]);
  assert.deepEqual(folderNames(notes, "", {}), ["intro.md"]);
  assert.deepEqual(folderNames(notes, "missing", {}), []);
});

test("a page dropped between two rows takes that row", () => {
  const names = ["a.md", "b.md", "c.md"];
  // Dragged down: the rows it passes shift up behind it.
  assert.deepEqual(placedFolderNames(names, "a.md", 2), [
    "b.md",
    "a.md",
    "c.md",
  ]);
  assert.deepEqual(placedFolderNames(names, "a.md", 3), [
    "b.md",
    "c.md",
    "a.md",
  ]);
  // Dragged up, and dropped back where it started.
  assert.deepEqual(placedFolderNames(names, "c.md", 0), [
    "c.md",
    "a.md",
    "b.md",
  ]);
  assert.deepEqual(placedFolderNames(names, "b.md", 1), names);
  assert.deepEqual(placedFolderNames(names, "b.md", 2), names);
  // Arriving from another folder, so the name is not in the list yet.
  assert.deepEqual(placedFolderNames(names, "new.md", 1), [
    "a.md",
    "new.md",
    "b.md",
    "c.md",
  ]);
  assert.deepEqual(placedFolderNames([], "new.md", 0), ["new.md"]);
  assert.deepEqual(placedFolderNames(names, "new.md", 99), [
    ...names,
    "new.md",
  ]);
});

test("a folder with nothing to say is dropped from the file", () => {
  const order = { "": ["a.md"], guides: ["b.md"] };
  assert.deepEqual(withFolderOrder(order, "guides", ["c.md"]), {
    "": ["a.md"],
    guides: ["c.md"],
  });
  assert.deepEqual(withFolderOrder(order, "guides", []), { "": ["a.md"] });
});

test("a renamed page keeps its place", () => {
  const order = { guides: ["a.md", "b.md"] };
  assert.deepEqual(renamedInOrder(order, "guides/a.md", "guides/z.md", false), {
    guides: ["z.md", "b.md"],
  });
  // A page the file never named has no place to keep.
  assert.equal(renamedInOrder(order, "guides/c.md", "guides/d.md", false), order);
});

test("renaming a folder carries the pages inside it", () => {
  const order = { guides: ["a.md"], "guides/deep": ["b.md"], notes: ["c.md"] };
  assert.deepEqual(renamedInOrder(order, "guides", "manuals", true), {
    manuals: ["a.md"],
    "manuals/deep": ["b.md"],
    notes: ["c.md"],
  });
});

test("names the library no longer holds are dropped", () => {
  const order = { "": ["a.md", "gone.md"], guides: ["b.md"], old: ["c.md"] };
  assert.deepEqual(prunedOrder(order, pages("a.md", "guides/b.md")), {
    "": ["a.md"],
    guides: ["b.md"],
  });
});

test("hidden entries are not pages", () => {
  assert.equal(isHiddenEntryName(".folio"), true);
  assert.equal(isHiddenEntryName(".DS_Store"), true);
  assert.equal(isHiddenEntryName("guides"), false);
});
