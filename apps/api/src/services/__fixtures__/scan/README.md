# Real scan fixtures (NOT committed)

Drop the **original photos** (the bytes sent to the LINE OA, before any
processing) here as `.jpg` / `.jpeg` / `.png`. `scan-enhance.real.test.ts` picks
up whatever is present and runs the real pipeline over it; with the directory
empty the test skips, so a clean checkout stays green.

    apps/api/src/services/__fixtures__/scan/
      wood-table-invoice.jpg      ← the photo
      out/wood-table-invoice.bw.jpg      ← written by the test, open to eyeball
      out/wood-table-invoice.color.jpg

## Why this is gitignored

These are real user documents. The reported sample alone carries a name, a home
address and a bank account number. Scan fixtures are exactly the kind of file
that looks harmless as "test data" and then lives in git history forever, so the
whole directory (this README aside) is ignored — see `.gitignore`. If a fixture
ever needs to be shared, redact it first and say so in its filename.

## Naming

A fixture whose name contains `expect-crop` additionally asserts that the
pipeline actually cropped away background: the output must be meaningfully
smaller than the source frame and all four corners must read as paper. Use it
for photos where the page clearly does not fill the frame.

Everything else is checked for the invariants that hold for any input:

- no edge-detection complaint ever reaches the user (Issue 1)
- the re-crop budget is respected (Issue 2)
- a decodable JPEG always comes out
