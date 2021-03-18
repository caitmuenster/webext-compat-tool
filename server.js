const express = require('express');
const fileUpload = require('express-fileupload');
const app = express();
const fs = require('fs-extra');
const path = require('path');
const queue = require('./lib/queue');
const { v1: uuid } = require('uuid');

const TEMP_DIR = path.join(__dirname, '.temp');

const store = require('./lib/store');

if (!process.env.DEVELOPMENT) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/.well-known/acme-challenge/')) {
      next();
    } else {
      if (req.headers['x-forwarded-proto'] !== 'https') {
        res.redirect(`https://${req.header('host')}${req.url}`);
      } else {
        res.header(
          'Content-Security-Policy',
          "default-src 'none'; connect-src 'self' www.google-analytics.com; img-src 'self' www.google-analytics.com; script-src 'self' use.fontawesome.com 'unsafe-eval' cdn.fontawesome.com www.google-analytics.com; style-src 'self' code.cdn.mozilla.net use.fontawesome.com; font-src code.cdn.mozilla.net use.fontawesome.com"
        );
        // res.header('Strict-Transport-Security', 'max-age=63072000');
        next();
      }
    }
  });
}

app.use(function(req, res, next) {
  res.header('X-Frame-Options', 'DENY');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-XSS-Protection', '1; mode=block');
  next();
});

// default options
app.use(fileUpload());

app.use(express.static('static'));

app.get('/', function(req, res) {
  sendPage(res, 'index.html');
});

app.post('/upload', function(req, res) {
  if (!req.files) return res.status(400).send('No files were uploaded.');

  // The name of the input field (i.e. "sampleFile") is used to retrieve the uploaded file
  let sampleFile = req.files.package;

  let id = uuid();

  let tempPackagePath = path.join(TEMP_DIR, sampleFile.name);

  store
    .set(id, { state: 'created' })
    .then(fs.ensureDir(TEMP_DIR))
    .then(
      () =>
        new Promise((resolve, reject) => {
          let tries = 3;
          function check() {
            tries--;
            fs.pathExists(tempPackagePath).then(resolve).catch(() => {
              if (tries) {
                check();
              } else {
                reject('file upload failed');
              }
            });
          }
          check();
        })
    )
    .then(function() {
      // Use the mv() method to place the file somewhere on your server
      sampleFile.mv(tempPackagePath, function(err) {
        if (err) {
          console.log(err, 'mv error');
          return res.status(500).send(err);
        }

        res.redirect('/test/' + id);

        queue.addJob({
          id: id,
          packagePath: path.join(TEMP_DIR, sampleFile.name)
        });
      });
    })
    .catch(e => res.end(e));
});

app.get('/test/:id', function(req, res) {
  const id = req.params.id;
  store.get(id).then(r => sendPage(res, 'run.html')).catch(e => {
    sendPage(res, '404.html').catch(e => res.end(e));
  });
});

function sendPage(res, file) {
  return Promise.all([
    fs
      .readFile(path.join(__dirname, 'views', file))
      .then(s => s.toString('utf8')),
    fs
      .readFile(path.join(__dirname, 'views', 'footer.html'))
      .then(s => s.toString('utf8'))
  ])
    .then(([content, footer]) => {
      res.type('html');
      res.end(
        content
          .toString('utf8')
          .replace('<!-- FOOTER -->', footer.toString('utf8'))
      );
    })
    .catch(e => {
      res.end('an error occurred.');
    });
}

app.get('/status/:id', function(req, res) {
  store.get(req.params.id).then(r => JSON.stringify(r)).then(res.end.bind(res));
});

app.get('/stats', function(req, res) {
  Promise.all([
    store.get('tests_run', 0),
    store.get('tests_passed', 0),
    store.get('tests_failed', 0),
    store.get('tests_errored', 0)
  ])
    .then(([total, passed, failed, errors]) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.json({ total, passed, failed, errors });
    })
    .catch(e => res.end(e));
});

app.get('/compat', function(req, res) {
  store
    .getKeys('compat-error:*')
    .then(keys => Promise.all(
      keys.map(async k => {
        return {
          text: k.substr(13),
          count: await store.get(k, 0)
        };
      })
    ))
    .then(results => {
      res.header('Access-Control-Allow-Origin', '*');
      res.json(results);
    })
    .catch(e => res.end(e));
});

app.get('/pulse', function(req, res) {
  store
    .getLast('pulse', process.env.PULSE_RANGE || 100)
    .then(data => {
      res.header('Access-Control-Allow-Origin', '*');
      res.json(data);
    })
    .catch(e => res.end(e.toString()));
});

setInterval(function() {
  Promise.all([
    store.get('tests_run', 0),
    store.get('tests_passed', 0),
    store.get('tests_failed', 0),
    store.get('tests_errored', 0)
  ]).then(([total, passed, failed, errors]) => {
    store.enqueue('pulse', { time: Date.now(), total, passed, failed, errors });
  });
}, 1000 * 60 * 60);

port = process.env.PORT || 8080;

app.listen(port, function() {
  console.log(`Listening on localhost:${port}`);
});
