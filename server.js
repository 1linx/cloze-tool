require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const supabase = require('./lib/supabaseClient');

app.use(express.json());

// Defense-in-depth: explicitly forbid access to dotfiles (.env, .git, etc.)
// regardless of how static serving is configured.
app.use((req, res, next) => {
  if (/(^|\/)\.(env|git)/.test(req.path)) return res.status(403).end();
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// A small health endpoint
app.get('/_health', (req, res) => res.json({ ok: true }));

// Admin authentication endpoint
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return res.status(500).json({ error: 'Admin password not configured' });
  }

  if (password === adminPassword) {
    const token = Buffer.from(`admin:${Date.now()}`).toString('base64');
    return res.json({ success: true, token });
  }

  res.status(401).json({ error: 'Invalid password' });
});

// Reset endpoint - reloads data from Supabase/data.json and broadcasts to all clients
app.post('/api/reset', async (_req, res) => {
  const preservedAdminUsers = { ...sharedState.adminUsers };

  sharedState = await loadSharedState();
  sharedState.adminUsers = preservedAdminUsers;

  io.sockets.sockets.forEach(socket => {
    sharedState.userPages[socket.id] = 1;
    sharedState.userBlanks[socket.id] = {};
    const pageToSend = 1;
    const isAdmin = sharedState.adminUsers[socket.id] || false;

    socket.emit('state', {
      title: sharedState.title,
      instructions: sharedState.instructions,
      totalPages: sharedState.totalPages,
      currentPage: pageToSend,
      sentences: sharedState.pages[pageToSend].sentences,
      pool: shuffled(getDedupedPool(pageToSend, isAdmin)),
      blanks: {},
      solution: getSolutionMap(pageToSend),
      unlockedWords: sharedState.unlockedWords[pageToSend] || {},
      isAdmin
    });
  });

  res.json({ ok: true, message: 'Exercise reset successfully' });
});

// --- Business logic: load and parse data ---
async function loadSharedState() {
  let rawData;

  if (supabase) {
    try {
      const { data: puzzle, error: puzzleError } = await supabase
        .from('puzzles')
        .select('*')
        .limit(1)
        .single();

      if (puzzleError) throw puzzleError;

      const { data: sentencesData, error: sentencesError } = await supabase
        .from('sentences')
        .select('*')
        .eq('puzzle_id', puzzle.id)
        .order('page_number', { ascending: true })
        .order('display_order', { ascending: true });

      if (sentencesError) throw sentencesError;

      const pageGroups = {};
      sentencesData.forEach(s => {
        const pageNum = s.page_number || 1;
        if (!pageGroups[pageNum]) pageGroups[pageNum] = [];
        pageGroups[pageNum].push(s.sentence_text);
      });

      rawData = { title: puzzle.title, instructions: puzzle.instructions, pageGroups };
      console.log('Data loaded from Supabase');
    } catch (err) {
      console.error("Error loading from Supabase:", err);
      console.log('Falling back to data.json');
      rawData = loadFromDataJson();
    }
  } else {
    console.log('Supabase not configured, loading from data.json');
    rawData = loadFromDataJson();
  }

  const pages = {};
  const totalPages = Object.keys(rawData.pageGroups).length;

  Object.entries(rawData.pageGroups).forEach(([pageNum, sentenceTexts]) => {
    const pageNumber = parseInt(pageNum);
    const sentences = [];
    const pool = [];

    sentenceTexts.forEach((line, si) => {
      const tokens = [];
      const parts = line.split(/(\[\[.*?\]\])/);

      parts.forEach(part => {
        if (part.startsWith('[[') && part.endsWith(']]')) {
          const word = part.slice(2, -2);
          pool.push({
            word,
            sentenceIndex: si,
            tokenIndex: tokens.length,
            pageNumber
          });
          tokens.push(null);
        } else {
          const words = part.trim().split(/\s+/);
          words.forEach(w => { if (w) tokens.push(w); });
        }
      });
      sentences.push({ tokens });
    });

    pages[pageNumber] = { sentences, pool };
  });

  return {
    title: rawData.title,
    instructions: rawData.instructions,
    totalPages,
    pages,
    userPages: {},
    userBlanks: {}, // { socketId: { pageNum: { "si-ti": wordText } } }
    adminUsers: {},
    unlockedWords: {} // { pageNum: { wordText: true } }
  };
}

function loadFromDataJson() {
  const dataPath = path.join(__dirname, 'data.json');
  try {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    let pageGroups;
    if (data.pages) {
      pageGroups = data.pages;
    } else if (data.sentences) {
      pageGroups = { 1: data.sentences };
    } else {
      pageGroups = { 1: [] };
    }
    return {
      title: data.title || "Fill the blanks",
      instructions: data.instructions || "Drag words from the side panel into the rectangular blanks.",
      pageGroups
    };
  } catch (err) {
    console.error("Error reading data.json:", err);
    return { title: "Error", instructions: "Could not load data.", pageGroups: { 1: [] } };
  }
}

// --- Helpers ---

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Returns deduplicated pool by word text, filtered by unlock status for non-admins.
// Each item: { id: wordText, word: wordText }
function getDedupedPool(pageNumber, isAdmin) {
  const page = sharedState.pages[pageNumber];
  if (!page) return [];

  let pool = page.pool;

  if (!isAdmin) {
    if (!sharedState.unlockedWords[pageNumber]) sharedState.unlockedWords[pageNumber] = {};
    const unlocked = sharedState.unlockedWords[pageNumber];
    pool = pool.filter(w => unlocked[w.word]);
  }

  const seen = new Set();
  return pool.reduce((acc, w) => {
    if (!seen.has(w.word)) {
      seen.add(w.word);
      acc.push({ id: w.word, word: w.word });
    }
    return acc;
  }, []);
}

// Returns map of blank positions to correct word text, for all blanks on a page.
function getSolutionMap(pageNumber) {
  const page = sharedState.pages[pageNumber];
  if (!page) return {};
  const map = {};
  page.pool.forEach(w => { map[`${w.sentenceIndex}-${w.tokenIndex}`] = w.word; });
  return map;
}

// --- Shared state ---
let sharedState = null;

(async () => {
  sharedState = await loadSharedState();
  console.log('Shared state initialized');
})();

app.get('/api/sentences', (_req, res) => {
  if (!sharedState) return res.status(503).json({ error: 'Server is initializing. Please try again.' });
  res.json({ title: sharedState.title, instructions: sharedState.instructions, totalPages: sharedState.totalPages });
});

// --- WebSocket logic ---
io.on('connection', (socket) => {
  if (!sharedState) {
    socket.emit('error', { message: 'Server is initializing. Please refresh the page.' });
    socket.disconnect();
    return;
  }

  const initialPage = 1;
  sharedState.userPages[socket.id] = initialPage;
  sharedState.userBlanks[socket.id] = {};
  const isAdmin = sharedState.adminUsers[socket.id] || false;

  socket.emit('state', {
    title: sharedState.title,
    instructions: sharedState.instructions,
    totalPages: sharedState.totalPages,
    currentPage: initialPage,
    sentences: sharedState.pages[initialPage].sentences,
    pool: shuffled(getDedupedPool(initialPage, isAdmin)),
    blanks: sharedState.userBlanks[socket.id][initialPage] || {},
    solution: getSolutionMap(initialPage),
    unlockedWords: sharedState.unlockedWords[initialPage] || {},
    isAdmin
  });

  // Admin login
  socket.on('admin_login', ({ token }) => {
    if (token && token.startsWith('YWRtaW4')) {
      sharedState.adminUsers[socket.id] = true;
      const currentPage = sharedState.userPages[socket.id];

      socket.emit('admin_authenticated', {
        isAdmin: true,
        pool: shuffled(getDedupedPool(currentPage, true)),
        unlockedWords: sharedState.unlockedWords[currentPage] || {}
      });
    } else {
      socket.emit('admin_auth_failed');
    }
  });

  // Admin unlock single word
  socket.on('admin_unlock_word', ({ wordText }) => {
    if (!sharedState.adminUsers[socket.id]) return;
    const pageNumber = sharedState.userPages[socket.id];
    if (!pageNumber || !sharedState.pages[pageNumber]) return;

    if (!sharedState.unlockedWords[pageNumber]) sharedState.unlockedWords[pageNumber] = {};
    sharedState.unlockedWords[pageNumber][wordText] = true;

    // Send word to non-admin clients on this page
    io.sockets.sockets.forEach(clientSocket => {
      const isClientAdmin = sharedState.adminUsers[clientSocket.id];
      const clientPage = sharedState.userPages[clientSocket.id];
      if (!isClientAdmin && clientPage === pageNumber) {
        clientSocket.emit('word_unlocked_by_admin', { wordText });
      }
    });

    socket.emit('word_unlock_confirmed', { wordText });
  });

  // Admin unlock all words for current page
  socket.on('admin_unlock_all', () => {
    if (!sharedState.adminUsers[socket.id]) return;
    const pageNumber = sharedState.userPages[socket.id];
    if (!pageNumber || !sharedState.pages[pageNumber]) return;

    if (!sharedState.unlockedWords[pageNumber]) sharedState.unlockedWords[pageNumber] = {};

    const pagePool = sharedState.pages[pageNumber].pool;
    pagePool.forEach(w => { sharedState.unlockedWords[pageNumber][w.word] = true; });

    const dedupedWords = getDedupedPool(pageNumber, true); // all words, deduped

    io.sockets.sockets.forEach(clientSocket => {
      const isClientAdmin = sharedState.adminUsers[clientSocket.id];
      const clientPage = sharedState.userPages[clientSocket.id];
      if (!isClientAdmin && clientPage === pageNumber) {
        clientSocket.emit('all_words_unlocked_by_admin', { words: shuffled(dedupedWords) });
      }
    });

    socket.emit('all_words_unlocked', { unlockedWords: sharedState.unlockedWords[pageNumber] });
  });

  // Handle page change
  socket.on('change_page', ({ pageNumber }) => {
    if (!pageNumber || pageNumber < 1 || pageNumber > sharedState.totalPages) return;

    sharedState.userPages[socket.id] = pageNumber;
    const isAdmin = sharedState.adminUsers[socket.id] || false;

    socket.emit('page_state', {
      pageNumber,
      sentences: sharedState.pages[pageNumber].sentences,
      pool: shuffled(getDedupedPool(pageNumber, isAdmin)),
      blanks: (sharedState.userBlanks[socket.id] || {})[pageNumber] || {},
      solution: getSolutionMap(pageNumber),
      totalPages: sharedState.totalPages,
      isAdmin,
      unlockedWords: sharedState.unlockedWords[pageNumber] || {}
    });
  });

  // Place word in blank
  socket.on('place_word', ({ wordText, blank }) => {
    const pageNumber = sharedState.userPages[socket.id];
    if (!pageNumber || !sharedState.pages[pageNumber]) return;

    // Validate: word exists in this page's solution
    if (!sharedState.pages[pageNumber].pool.some(w => w.word === wordText)) return;

    if (!sharedState.userBlanks[socket.id]) sharedState.userBlanks[socket.id] = {};
    if (!sharedState.userBlanks[socket.id][pageNumber]) sharedState.userBlanks[socket.id][pageNumber] = {};
    sharedState.userBlanks[socket.id][pageNumber][blank] = wordText;
    socket.emit('word_placed', { wordText, blank, pageNumber });
  });

  // Remove word from blank
  socket.on('remove_word', ({ blank }) => {
    const pageNumber = sharedState.userPages[socket.id];
    if (!pageNumber || !sharedState.pages[pageNumber]) return;

    const userBlanks = (sharedState.userBlanks[socket.id] || {})[pageNumber] || {};
    if (userBlanks[blank] !== undefined) {
      delete sharedState.userBlanks[socket.id][pageNumber][blank];
      socket.emit('word_removed', { blank, pageNumber });
    }
  });

  // Disconnect: clean up user tracking
  socket.on('disconnect', () => {
    delete sharedState.userPages[socket.id];
    delete sharedState.userBlanks[socket.id];
    delete sharedState.adminUsers[socket.id];
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
