# SEO Test Summary

| Category | Passed | Failed | Skipped | Total |
|----------|--------|--------|---------|-------|
| Blockers | 0 | 0 | 0 | 0 |
| Warnings | 56 | 10 | 0 | 66 |
| Other    | 3 | 1 | 0 | 4 |

## Warnings (non-blocking)

- **WARN** [metadata] should have the correct canonical URL
  > Error: Expected canonical to be "http://localhost:3000/collection1"

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"http://localhost:3000/collection1"[39m
Received: [31m"http://localhost:3000/collection1[7m/[27m"[39m
- **WARN** [metadata] should have the correct canonical URL
  > Error: Expected canonical to be "http://localhost:3000/product2"

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"http://localhost:3000/product2"[39m
Received: [31m"http://localhost:3000/product2[7m/[27m"[39m
- **WARN** [metadata] should have the correct canonical URL
  > Error: Expected canonical to be "http://localhost:3000/product3"

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"http://localhost:3000/product3"[39m
Received: [31m"http://localhost:3000/product3[7m/[27m"[39m
- **WARN** [metadata] should have the correct canonical URL
  > Error: Expected canonical to be "http://localhost:3000/product8"

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"http://localhost:3000/product8"[39m
Received: [31m"http://localhost:3000/product8[7m/[27m"[39m
- **WARN** [metadata] Raw HTML canonical should not point to the wrong URL (Canonical Misdirection)
  > Error: Found a canonical tag in raw HTML pointing to "http://localhost:3000/collection1/". This is a Canonical Misdirection Trap — Googlebot may drop the page before JavaScript hydration fixes it to "http://localhost:3000/collection1".

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"http://localhost:3000/collection1"[39m
Received: [31m"http://localhost:3000/collection1[7m/[27m"[39m
- **WARN** [metadata] Raw HTML canonical should not point to the wrong URL (Canonical Misdirection)
  > Error: Found a canonical tag in raw HTML pointing to "http://localhost:3000/product8/". This is a Canonical Misdirection Trap — Googlebot may drop the page before JavaScript hydration fixes it to "http://localhost:3000/product8".

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"http://localhost:3000/product8"[39m
Received: [31m"http://localhost:3000/product8[7m/[27m"[39m
- **WARN** [metadata] Raw HTML canonical should not point to the wrong URL (Canonical Misdirection)
  > Error: Found a canonical tag in raw HTML pointing to "http://localhost:3000/product2/". This is a Canonical Misdirection Trap — Googlebot may drop the page before JavaScript hydration fixes it to "http://localhost:3000/product2".

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"http://localhost:3000/product2"[39m
Received: [31m"http://localhost:3000/product2[7m/[27m"[39m
- **WARN** [metadata] Raw HTML canonical should not point to the wrong URL (Canonical Misdirection)
  > Error: Found a canonical tag in raw HTML pointing to "http://localhost:3000/product3/". This is a Canonical Misdirection Trap — Googlebot may drop the page before JavaScript hydration fixes it to "http://localhost:3000/product3".

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"http://localhost:3000/product3"[39m
Received: [31m"http://localhost:3000/product3[7m/[27m"[39m
- **WARN** [metadata] should have the correct canonical URL
  > Error: Expected canonical to be "http://localhost:3000/product7"

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"http://localhost:3000/product7"[39m
Received: [31m"http://localhost:3000/product7[7m/[27m"[39m
- **WARN** [metadata] Raw HTML canonical should not point to the wrong URL (Canonical Misdirection)
  > Error: Found a canonical tag in raw HTML pointing to "http://localhost:3000/product7/". This is a Canonical Misdirection Trap — Googlebot may drop the page before JavaScript hydration fixes it to "http://localhost:3000/product7".

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"http://localhost:3000/product7"[39m
Received: [31m"http://localhost:3000/product7[7m/[27m"[39m

---

**Result: PASSED with warnings** — 10 warning(s) should be reviewed.