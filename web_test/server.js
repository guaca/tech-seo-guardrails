const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0]; // ignore query strings
    let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
    
    // Auto-resolve directories to index.html
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
    }
    // Also handle paths without trailing slashes that map to directories
    else if (!fs.existsSync(filePath) && fs.existsSync(filePath + '/index.html')) {
        filePath = path.join(filePath, 'index.html');
    }
    
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.xml': 'application/xml',
        '.txt': 'text/plain',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif'
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if(err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end('Sorry, server error: '+err.code+' ..\n');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Test server running at http://localhost:${PORT}/`);
    console.log(`Serving static files from: ${PUBLIC_DIR}`);
});