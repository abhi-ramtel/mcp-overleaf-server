import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePdfPageUsage } from "../src/core/latexCompile.js";

test("parses the bottom whitespace of the final PDF page from Poppler XHTML", () => {
  const xhtml = `<doc>
  <page width="612.000000" height="792.000000">
    <word xMin="36" yMin="40" xMax="70" yMax="50">First</word>
  </page>
  <page width="612.000000" height="792.000000">
    <word xMin="36" yMin="600" xMax="70" yMax="610">Last</word>
    <word xMin="72" yMin="680" xMax="120" yMax="690">line</word>
  </page>
</doc>`;

  assert.deepEqual(parsePdfPageUsage(xhtml), {
    pageHeightPoints: 792,
    contentBottomYPoints: 690,
    bottomWhitespacePoints: 102,
  });
});

test("returns no layout data when Poppler XHTML has no text bounds", () => {
  assert.equal(parsePdfPageUsage(`<doc><page width="612" height="792"></page></doc>`), undefined);
});
