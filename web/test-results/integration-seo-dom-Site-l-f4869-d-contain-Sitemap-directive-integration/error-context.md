# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: integration/seo-dom.spec.js >> Site-level SEO checks >> robots.txt should be accessible and contain Sitemap directive
- Location: node_modules/tech-seo-guardrails/tests/integration/seo-dom.spec.js:76:21

# Error details

```
Error: robots.txt should return 200 or 304 (got 404)

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```