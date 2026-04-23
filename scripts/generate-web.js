const fs = require('fs');
const path = require('path');

const webDir = path.join(__dirname, '..', 'web');

// Ensure web directory exists
if (!fs.existsSync(webDir)) {
  fs.mkdirSync(webDir);
}

const csvPath = path.join(__dirname, '..', 'pages.template.csv');
const csvData = fs.readFileSync(csvPath, 'utf-8');

const lines = csvData.trim().split('\n');
const headers = lines[0].split(',');
const rows = lines.slice(1).map(line => {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else current += char;
  }
  values.push(current);
  return values;
});

const pages = rows.map(row => {
  const page = {};
  headers.forEach((header, i) => {
    page[header.trim()] = row[i]?.trim();
  });
  return page;
});

function getRelativePath(url) {
  try {
    const parsed = new URL(url);
    let p = parsed.pathname;
    if (p.endsWith('/')) p += 'index.html';
    else if (!p.endsWith('.html')) p += '/index.html';
    return p.startsWith('/') ? p.slice(1) : p;
  } catch {
    return 'index.html';
  }
}

const sitemapUrls = [];
const prodBaseUrl = 'http://localhost:3000';

pages.forEach(page => {
  let fullUrl = page['Address'].replace('https://your-site.com', prodBaseUrl);
  // Normalize: ensure trailing slash if it looks like a directory
  if (!fullUrl.endsWith('/') && !fullUrl.split('/').pop().includes('.')) {
    fullUrl += '/';
  }
  
  const relPath = getRelativePath(fullUrl);
  const fullPath = path.join(webDir, relPath);
  
  sitemapUrls.push(fullUrl);

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const isProduct = fullUrl.includes('/products/');
  
  let jsonLd = '';
  let productPriceHtml = '';
  if (isProduct) {
    const name = page['Title 1'].split('|')[0].trim();
    const price = fullUrl.includes('new') ? '34.99' : '29.99';
    jsonLd = `
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "${name}",
      "image": "${(page['og:image'] || 'https://your-site.com/images/classic-tee.jpg').replace('https://your-site.com', prodBaseUrl)}",
      "description": "${page['Meta Description 1']}",
      "offers": {
        "@type": "Offer",
        "priceCurrency": "USD",
        "price": "${price}",
        "availability": "https://schema.org/InStock"
      }
    }
    </script>`;
    productPriceHtml = `<p>Current Price: <span class="price">${price}</span></p>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${page['Title 1']}</title>
    <meta name="description" content="${page['Meta Description 1']}">
    <link rel="canonical" href="${page['Canonical Link Element 1'].replace('https://your-site.com', prodBaseUrl)}">
    <meta name="robots" content="${page['Meta Robots 1']}">
    <meta property="og:title" content="${page['og:title'] || page['Title 1']}">
    <meta property="og:description" content="${page['og:description'] || page['Meta Description 1']}">
    <meta property="og:image" content="${(page['og:image'] || '').replace('https://your-site.com', prodBaseUrl)}">
    <meta property="og:type" content="${page['og:type'] || 'website'}">
    <meta property="og:url" content="${(page['og:url'] || fullUrl).replace('https://your-site.com', prodBaseUrl)}">
    <meta name="twitter:card" content="${page['twitter:card'] || 'summary'}">
    <meta name="twitter:title" content="${page['twitter:title'] || page['Title 1']}">
    <meta name="twitter:description" content="${page['twitter:description'] || page['Meta Description 1']}">
    <meta name="twitter:image" content="${(page['twitter:image'] || '').replace('https://your-site.com', prodBaseUrl)}">
    ${jsonLd}
</head>
<body>
    <h1>${page['H1-1']}</h1>
    
    ${isProduct ? productPriceHtml : ''}

    <p>
      This is a placeholder body text to ensure we meet the minimum word count requirements for the SEO content quality checks. 
      The framework requires at least one hundred words of visible text on the page to avoid being flagged as thin content. 
      Technical SEO is crucial for discoverability and user experience. By implementing automated guardrails, 
      we can maintain high standards across the entire site without manual oversight on every single pull request. 
      This approach scales beautifully as the number of pages grows. Googlebot expects clear signals like unique titles, 
      descriptive meta tags, and valid structured data. Let us keep adding more words here to be absolutely safe. 
      Word count is an easy metric but often indicative of rendering issues if it drops too low unexpectedly. 
      We are now likely over the threshold but let us add one more sentence just in case. Happy testing!
    </p>

    <nav>
      <a href="/">Home</a>
      <a href="/collections/shirts/">Shirts</a>
      <a href="/about/">About</a>
    </nav>
</body>
</html>`;

  fs.writeFileSync(fullPath, html);
});

// Generate Sitemap
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map(url => `  <url><loc>${url}</loc></url>`).join('\n')}
</urlset>`;

fs.writeFileSync(path.join(webDir, 'sitemap.xml'), sitemap);

// Create robots.txt
const robotsTxt = `User-agent: *
Allow: /

Sitemap: http://localhost:3000/sitemap.xml
`;
fs.writeFileSync(path.join(webDir, 'robots.txt'), robotsTxt);

console.log('Web directory generated successfully!');
