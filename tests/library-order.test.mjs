import assert from "node:assert/strict";
import test from "node:test";
import {
  folderMoveIssue,
  folderNames,
  folderTrail,
  folderTree,
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

/** The shape the panel builds its rows from: folder path → pages inside it. */
const groups = (...entries) =>
  entries
    .map((entry) => (Array.isArray(entry) ? entry : [entry, []]))
    .sort(([left], [right]) => left.localeCompare(right));

/** A tree flattened the way the panel draws it: `depth:path` per row. */
const drawn = (nodes, depth = 0) =>
  nodes.flatMap((node) => [
    `${depth}:${node.path}`,
    ...drawn(node.children, depth + 1),
  ]);

test("a folder inside a folder is listed inside it, not again from the root", () => {
  const tree = folderTree(
    groups(
      ["", ["loose.md"]],
      ["Deep Learning/Diffusion", ["ddim.md"]],
      ["Deep Learning/Transformers", ["attention.md"]],
      ["Zoo", ["gnu.md"]],
    ),
  );

  // "Deep Learning" holds no pages of its own and is named by no group, but
  // what is under it puts it on screen, with its folders drawn inside it.
  assert.deepEqual(drawn(tree), [
    "0:Deep Learning",
    "1:Deep Learning/Diffusion",
    "1:Deep Learning/Transformers",
    "0:Zoo",
  ]);

  // The root's pages belong to no node — the panel gives them their own row.
  assert.deepEqual(
    tree.map((node) => node.pages),
    [[], ["gnu.md"]],
  );
});

test("a folder holding nothing anywhere below it is left out, unless kept", () => {
  const listing = groups(["Notes", ["one.md"]], "Notes/Empty", "Nowhere");

  assert.deepEqual(drawn(folderTree(listing)), ["0:Notes"]);

  // A folder the reader just made is kept, and keeps its parent on screen.
  assert.deepEqual(drawn(folderTree(listing, (path) => path === "Notes/Empty")), [
    "0:Notes",
    "1:Notes/Empty",
  ]);
  // While something is in hand every folder is somewhere to drop.
  assert.deepEqual(drawn(folderTree(listing, () => true)), [
    "0:Notes",
    "1:Notes/Empty",
    "0:Nowhere",
  ]);
});

test("the way down to a folder names every folder on it", () => {
  assert.deepEqual(folderTrail("a/b/c"), ["a", "a/b", "a/b/c"]);
  assert.deepEqual(folderTrail("a"), ["a"]);
  assert.deepEqual(folderTrail(""), []);
});

test("a folder cannot be carried into itself, or onto a name already there", () => {
  const folders = ["Deep Learning", "Deep Learning/Diffusion", "Zoo", "Zoo/Diffusion"];

  // The move that changes nothing is not an error, just nothing to do.
  assert.equal(folderMoveIssue("Deep Learning/Diffusion", "Deep Learning", folders), "same");
  assert.equal(folderMoveIssue("Zoo", "", folders), "same");

  // A folder cannot hold itself, and neither can anything under it.
  assert.equal(folderMoveIssue("Deep Learning", "Deep Learning", folders), "inside");
  assert.equal(
    folderMoveIssue("Deep Learning", "Deep Learning/Diffusion", folders),
    "inside",
  );
  // The root itself is not a folder anything can be carried into place of.
  assert.equal(folderMoveIssue("", "Zoo", folders), "inside");

  // A destination already holding that name is refused rather than replaced.
  assert.equal(folderMoveIssue("Deep Learning/Diffusion", "Zoo", folders), "taken");
  assert.equal(folderMoveIssue("Deep Learning/Diffusion", "", folders), undefined);
  assert.equal(folderMoveIssue("Zoo/Diffusion", "Deep Learning", folders), "taken");
});

test("moving a folder carries the order of every page under it", () => {
  const order = {
    "Deep Learning/Diffusion": ["ddim.md", "ancestral.md"],
    "Deep Learning/Diffusion/Samplers": ["euler.md"],
    Zoo: ["gnu.md"],
  };

  // A folder moved under a different parent keeps its pages in their places,
  // and takes the folders under it with it.
  assert.deepEqual(
    renamedInOrder(order, "Deep Learning/Diffusion", "Zoo/Diffusion", true),
    {
      "Zoo/Diffusion": ["ddim.md", "ancestral.md"],
      "Zoo/Diffusion/Samplers": ["euler.md"],
      Zoo: ["gnu.md"],
    },
  );
});
