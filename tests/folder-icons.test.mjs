import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanFolderIcon,
  FOLDER_COLOR_IDS,
  FOLDER_ICON_IDS,
  isFolderIconImage,
  MAX_ICON_IMAGE_LENGTH,
  parseFolderIcons,
  prunedFolderIcons,
  renamedFolderIcons,
  serializeFolderIcons,
  withFolderIcon,
} from "../app/folder-icons.js";

const image = (bytes = "iVBORw0KGgo=") => `data:image/png;base64,${bytes}`;

test("an unreadable icons file reads as no folder marks at all", () => {
  assert.deepEqual(parseFolderIcons(undefined), {});
  assert.deepEqual(parseFolderIcons(""), {});
  assert.deepEqual(parseFolderIcons("{"), {});
  assert.deepEqual(parseFolderIcons("[]"), {});
  assert.deepEqual(parseFolderIcons('{"folders":"compass"}'), {});
});

test("the icons file keeps only marks Folio can draw", () => {
  const icons = parseFolderIcons(
    JSON.stringify({
      version: 1,
      folders: {
        guides: { icon: "compass", color: "ocean" },
        research: { icon: "not-a-mark", color: "chartreuse" },
        notes: { icon: "flask", extra: "ignored" },
        pictures: { image: image() },
        broken: "compass",
        empty: {},
      },
    }),
  );
  assert.deepEqual(icons, {
    guides: { icon: "compass", color: "ocean" },
    notes: { icon: "flask" },
    pictures: { image: image() },
  });
});

test("the default colour is not written, so an untinted mark has one shape", () => {
  assert.deepEqual(cleanFolderIcon({ icon: "star", color: "default" }), {
    icon: "star",
  });
  assert.equal(cleanFolderIcon({ color: "default" }), undefined);
  assert.equal(cleanFolderIcon(undefined), undefined);
  assert.equal(cleanFolderIcon(["star"]), undefined);
});

test("only inline pictures small enough for a preferences file are drawn", () => {
  assert.ok(isFolderIconImage(image()));
  assert.ok(!isFolderIconImage("icons/folder.png"));
  assert.ok(!isFolderIconImage("https://example.com/folder.png"));
  assert.ok(!isFolderIconImage("data:text/html;base64,PHNjcmlwdD4="));
  assert.ok(!isFolderIconImage(`data:image/png;base64,<script>`));
  assert.ok(!isFolderIconImage(image("A".repeat(MAX_ICON_IMAGE_LENGTH))));
});

test("marks are set and cleared through one folder key", () => {
  const set = withFolderIcon({}, "guides", { icon: "compass" });
  assert.deepEqual(set, { guides: { icon: "compass" } });
  assert.deepEqual(withFolderIcon(set, "guides", undefined), {});
  assert.deepEqual(withFolderIcon(set, "guides", {}), {});
  // The library root is a folder like any other.
  assert.deepEqual(withFolderIcon({}, "", { icon: "book" }), {
    "": { icon: "book" },
  });
});

test("renaming a folder carries its mark, and the folders inside it", () => {
  const icons = {
    guides: { icon: "compass" },
    "guides/setup": { icon: "flask" },
    "guides-archive": { icon: "star" },
    notes: { icon: "book" },
  };
  assert.deepEqual(renamedFolderIcons(icons, "guides", "handbook"), {
    handbook: { icon: "compass" },
    "handbook/setup": { icon: "flask" },
    "guides-archive": { icon: "star" },
    notes: { icon: "book" },
  });
});

test("marks for folders the library no longer holds are dropped", () => {
  const icons = {
    "": { icon: "library" },
    guides: { icon: "compass" },
    gone: { icon: "star" },
  };
  assert.deepEqual(prunedFolderIcons(icons, ["guides", "notes"]), {
    "": { icon: "library" },
    guides: { icon: "compass" },
  });
});

test("the file is written sorted, so reordering marks does not churn it", () => {
  const written = serializeFolderIcons({
    notes: { icon: "book" },
    guides: { icon: "compass", color: "ocean" },
    dropped: { icon: "not-a-mark" },
  });
  assert.equal(
    written,
    `${JSON.stringify(
      {
        version: 1,
        folders: {
          guides: { icon: "compass", color: "ocean" },
          notes: { icon: "book" },
        },
      },
      undefined,
      2,
    )}\n`,
  );
  assert.deepEqual(parseFolderIcons(written), {
    guides: { icon: "compass", color: "ocean" },
    notes: { icon: "book" },
  });
});

test("every mark and colour the picker offers is one the file accepts", () => {
  for (const icon of FOLDER_ICON_IDS) {
    assert.deepEqual(cleanFolderIcon({ icon }), { icon });
  }
  for (const color of FOLDER_COLOR_IDS) {
    assert.deepEqual(
      cleanFolderIcon({ icon: "folder", color }),
      color === "default" ? { icon: "folder" } : { icon: "folder", color },
    );
  }
});
