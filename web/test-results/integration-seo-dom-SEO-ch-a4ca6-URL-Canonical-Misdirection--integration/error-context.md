# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: integration/seo-dom.spec.js >> SEO checks for: Collection1 page (/collection1) >> [metadata] Raw HTML canonical should not point to the wrong URL (Canonical Misdirection)
- Location: node_modules/tech-seo-guardrails/tests/integration/seo-dom.spec.js:420:33

# Error details

```
Error: Found a canonical tag in raw HTML pointing to "http://localhost:3000/collection1/". This is a Canonical Misdirection Trap — Googlebot may drop the page before JavaScript hydration fixes it to "http://localhost:3000/collection1".

expect(received).toBe(expected) // Object.is equality

Expected: "http://localhost:3000/collection1"
Received: "http://localhost:3000/collection1/"
```

# Page snapshot

```yaml
- heading "Collection 1" [level=1] [ref=e2]
```