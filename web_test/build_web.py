import os
import csv

html_template = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    {meta_desc}
    {canonical}
    {meta_robots}
    {og_tags}
    {twitter_tags}
    <link rel="icon" href="data:,">
</head>
<body>
    <h1>{h1}</h1>
    {h2s}
    <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
    <p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.</p>
</body>
</html>"""

def make_page(path, row):
    os.makedirs(f"web/public{path}", exist_ok=True)
    
    meta_desc = f'<meta name="description" content="{row[4]}">' if len(row) > 4 and row[4] else ""
    h1 = row[5] if len(row) > 5 else ""
    h2s = []
    if len(row) > 6 and row[6]: h2s.append(f'<h2>{row[6]}</h2>')
    if len(row) > 7 and row[7]: h2s.append(f'<h2>{row[7]}</h2>')
    if len(row) > 8 and row[8]: h2s.append(f'<h2>{row[8]}</h2>')
    canonical = f'<link rel="canonical" href="{row[9]}">' if len(row) > 9 and row[9] else ""
    meta_robots = f'<meta name="robots" content="{row[10]}">' if len(row) > 10 and row[10] else ""
    
    og_tags = []
    if len(row) > 11 and row[11]: og_tags.append(f'<meta property="og:title" content="{row[11]}">')
    if len(row) > 12 and row[12]: og_tags.append(f'<meta property="og:description" content="{row[12]}">')
    if len(row) > 13 and row[13]: og_tags.append(f'<meta property="og:image" content="{row[13]}">')
    if len(row) > 14 and row[14]: og_tags.append(f'<meta property="og:type" content="{row[14]}">')
    if len(row) > 15 and row[15]: og_tags.append(f'<meta property="og:url" content="{row[15]}">')
    
    tw_tags = []
    if len(row) > 16 and row[16]: tw_tags.append(f'<meta name="twitter:card" content="{row[16]}">')
    if len(row) > 17 and row[17]: tw_tags.append(f'<meta name="twitter:title" content="{row[17]}">')
    if len(row) > 18 and row[18]: tw_tags.append(f'<meta name="twitter:description" content="{row[18]}">')
    if len(row) > 19 and row[19]: tw_tags.append(f'<meta name="twitter:image" content="{row[19]}">')
    
    html = html_template.format(
        title=row[3] if len(row) > 3 else "",
        meta_desc=meta_desc,
        canonical=canonical,
        meta_robots=meta_robots,
        og_tags="\n    ".join(og_tags),
        twitter_tags="\n    ".join(tw_tags),
        h1=h1,
        h2s="\n    ".join(h2s)
    )
    
    with open(f"web/public{path}index.html", "w") as f:
        f.write(html)

sitemap_template = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{urls}
</urlset>"""

with open("pages.template.csv", "r") as f:
    reader = csv.reader(f)
    next(reader)
    urls = []
    for row in reader:
        if not row or not row[0]: continue
        path = row[0].replace("https://your-site.com", "")
        if not path.endswith("/"): path += "/"
        if not path.startswith("/"): path = "/" + path
        make_page(path, row)
        urls.append(f"  <url>\n    <loc>{row[0]}</loc>\n  </url>")
        
with open("web/public/sitemap.xml", "w") as f:
    f.write(sitemap_template.format(urls="\n".join(urls)))
    
print("Successfully generated static files from CSV.")
