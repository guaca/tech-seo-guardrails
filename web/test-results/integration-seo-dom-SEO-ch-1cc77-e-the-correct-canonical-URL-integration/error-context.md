# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: integration/seo-dom.spec.js >> SEO checks for: Product3 page (/product3) >> [metadata] should have the correct canonical URL
- Location: node_modules/tech-seo-guardrails/tests/integration/seo-dom.spec.js:415:33

# Error details

```
Error: Expected canonical to be "http://localhost:3000/product3"

expect(received).toBe(expected) // Object.is equality

Expected: "http://localhost:3000/product3"
Received: "http://localhost:3000/product3/"
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - heading "Product 3" [level=1] [ref=e2]
  - img "Product 3" [ref=e3]
```