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

app.use(express.static(path.join(__dirname, 'public')));

// A small health endpoint
app.get('/_health', (req, res) => res.json({ ok: true }));

// Reset endpoint - reloads data from Supabase/data.json and broadcasts to all clients
app.post('/api/reset', async (_req, res) => {
  sharedState = await loadSharedState(); // Reload data

  // Notify all connected clients of the new state
  io.sockets.sockets.forEach(socket => {
    const currentPage = sharedState.userPages[socket.id] || 1;

    // Ensure the page exists
    if (!sharedState.pages[currentPage]) {
      sharedState.userPages[socket.id] = 1;
    }

    const pageToSend = sharedState.userPages[socket.id] || 1;
    const userPool = [...sharedState.pages[pageToSend].pool];

    // Fisher-Yates shuffle
    for (let i = userPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [userPool[i], userPool[j]] = [userPool[j], userPool[i]];
    }

    socket.emit('state', {
      title: sharedState.title,
      instructions: sharedState.instructions,
      totalPages: sharedState.totalPages,
      currentPage: pageToSend,
      sentences: sharedState.pages[pageToSend].sentences,
      pool: userPool,
      blanks: sharedState.pages[pageToSend].blanks
    });
  });

  res.json({ ok: true, message: 'Exercise reset successfully' });
});

// --- Business logic: load and parse data ---
async function loadSharedState() {
  let rawData;

  // Try to fetch from Supabase first
  if (supabase) {
    try {
      // Fetch the first puzzle with its sentences
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

      // Group sentences by page
      const pageGroups = {};
      sentencesData.forEach(s => {
        const pageNum = s.page_number || 1; // Default to page 1 if not set
        if (!pageGroups[pageNum]) {
          pageGroups[pageNum] = [];
        }
        pageGroups[pageNum].push(s.sentence_text);
      });

      rawData = {
        title: puzzle.title,
        instructions: puzzle.instructions,
        pageGroups
      };

      console.log('Data loaded from Supabase');
    } catch (err) {
      console.error("Error loading from Supabase:", err);
      console.log('Falling back to data.json');
      rawData = loadFromDataJson();
    }
  } else {
    // Fallback to data.json if Supabase is not configured
    console.log('Supabase not configured, loading from data.json');
    rawData = loadFromDataJson();
  }

  // Create per-page state structure
  const pages = {};
  const totalPages = Object.keys(rawData.pageGroups).length;

  Object.entries(rawData.pageGroups).forEach(([pageNum, sentenceTexts]) => {
    const pageNumber = parseInt(pageNum);
    const sentences = [];
    const pool = [];
    const blanks = {};

    sentenceTexts.forEach((line, si) => {
      const tokens = [];
      // Split by brackets, keeping the delimiters
      const parts = line.split(/(\[\[.*?\]\])/);

      parts.forEach(part => {
        if (part.startsWith('[[') && part.endsWith(']]')) {
          // It's a blank: [[word]]
          const word = part.slice(2, -2);
          const wordId = `w-${pageNumber}-${si}-${tokens.length}`;
          pool.push({
            id: wordId,
            word,
            sentenceIndex: si,
            tokenIndex: tokens.length,
            pageNumber,
            placed: false,
            lockedBy: null
          });
          tokens.push(null);
        } else {
          // It's text: split by whitespace
          const words = part.trim().split(/\s+/);
          words.forEach(w => {
            if (w) tokens.push(w);
          });
        }
      });
      sentences.push({ tokens });
    });

    pages[pageNumber] = { sentences, pool, blanks };
  });

  return {
    title: rawData.title,
    instructions: rawData.instructions,
    totalPages,
    pages,
    userPages: {}
  };
}

// Fallback function to load from data.json
function loadFromDataJson() {
  const dataPath = path.join(__dirname, 'data.json');
  try {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    // Support both old format (sentences array) and new format (pages object)
    let pageGroups;
    if (data.pages) {
      // New format: pages object already structured
      pageGroups = data.pages;
    } else if (data.sentences) {
      // Old format: convert sentences array to page 1
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
    return {
      title: "Error",
      instructions: "Could not load data.",
      pageGroups: { 1: [] }
    };
  }
}

// --- Shared state for all users (in-memory for now) ---
// This is reset on server restart. For production, use a DB or cache.
let sharedState = null;

// Initialize shared state asynchronously
(async () => {
  sharedState = await loadSharedState();
  console.log('Shared state initialized');
})();

// API: get current state
app.get('/api/sentences', (_req, res) => {
  // Return the current shared state (for new clients)
  if (!sharedState) {
    return res.status(503).json({ error: 'Server is initializing. Please try again.' });
  }

  // Send metadata about the puzzle
  res.json({
    title: sharedState.title,
    instructions: sharedState.instructions,
    totalPages: sharedState.totalPages
  });
});

// --- WebSocket logic ---
io.on('connection', (socket) => {
  // Check if sharedState is loaded
  if (!sharedState) {
    socket.emit('error', { message: 'Server is initializing. Please refresh the page.' });
    socket.disconnect();
    return;
  }

  // Initialize user on page 1
  const initialPage = 1;
  sharedState.userPages[socket.id] = initialPage;

  // Create a shuffled version of the pool for this user (from page 1)
  const userPool = [...sharedState.pages[initialPage].pool];
  for (let i = userPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [userPool[i], userPool[j]] = [userPool[j], userPool[i]];
  }

  // Send current state to new client, with the shuffled pool
  socket.emit('state', {
    title: sharedState.title,
    instructions: sharedState.instructions,
    totalPages: sharedState.totalPages,
    currentPage: initialPage,
    sentences: sharedState.pages[initialPage].sentences,
    pool: userPool,
    blanks: sharedState.pages[initialPage].blanks
  });

  // Handle page change
  socket.on('change_page', ({ pageNumber }) => {
    // Validate page number
    if (!pageNumber || pageNumber < 1 || pageNumber > sharedState.totalPages) {
      return;
    }

    const currentPage = sharedState.userPages[socket.id];

    // Release all locks from current page
    if (currentPage && sharedState.pages[currentPage]) {
      sharedState.pages[currentPage].pool.forEach(word => {
        if (word.lockedBy === socket.id && !word.placed) {
          word.lockedBy = null;
          io.emit('word_unlocked', { id: word.id, pageNumber: currentPage });
        }
      });
    }

    // Update user's page
    sharedState.userPages[socket.id] = pageNumber;

    // Create a shuffled version of the new page's pool
    const newPagePool = [...sharedState.pages[pageNumber].pool];
    for (let i = newPagePool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newPagePool[i], newPagePool[j]] = [newPagePool[j], newPagePool[i]];
    }

    // Send new page state
    socket.emit('page_state', {
      pageNumber,
      sentences: sharedState.pages[pageNumber].sentences,
      pool: newPagePool,
      blanks: sharedState.pages[pageNumber].blanks,
      totalPages: sharedState.totalPages
    });
  });

  // Word select (lock)
  socket.on('select_word', ({ id }) => {
    const pageNumber = sharedState.userPages[socket.id];
    if (!pageNumber || !sharedState.pages[pageNumber]) return;

    const page = sharedState.pages[pageNumber];
    const wordToLock = page.pool.find(w => w.id === id);

    // Ensure word exists, is not placed, and is not locked by another user
    if (!wordToLock || wordToLock.placed || (wordToLock.lockedBy && wordToLock.lockedBy !== socket.id)) {
      return;
    }

    // Find and unlock ALL other words locked by this user on this page
    const previouslyLockedWords = page.pool.filter(w => w.lockedBy === socket.id && w.id !== id);
    if (previouslyLockedWords.length > 0) {
      previouslyLockedWords.forEach(word => {
        word.lockedBy = null;
        io.emit('word_unlocked', { id: word.id, pageNumber });
      });
    }

    // Lock the new word, if it's not already locked by this user
    if (wordToLock.lockedBy !== socket.id) {
      wordToLock.lockedBy = socket.id;
      io.emit('word_locked', { id, by: socket.id, pageNumber });
    }
  });

  // Word release (unlock)
  socket.on('release_word', ({ id }) => {
    const pageNumber = sharedState.userPages[socket.id];
    if (!pageNumber || !sharedState.pages[pageNumber]) return;

    const page = sharedState.pages[pageNumber];
    const word = page.pool.find(w => w.id === id);
    if (word && word.lockedBy === socket.id && !word.placed) {
      word.lockedBy = null;
      io.emit('word_unlocked', { id, pageNumber });
    }
  });

  // Place word in blank
  socket.on('place_word', ({ id, blank }) => {
    const pageNumber = sharedState.userPages[socket.id];
    if (!pageNumber || !sharedState.pages[pageNumber]) return;

    const page = sharedState.pages[pageNumber];
    const word = page.pool.find(w => w.id === id);
    if (word && word.lockedBy === socket.id && !word.placed) {
      // Remove any existing word from this blank position
      const existingWordId = page.blanks[blank];
      if (existingWordId) {
        const existingWord = page.pool.find(w => w.id === existingWordId);
        if (existingWord) {
          existingWord.placed = false;
          io.emit('word_removed', { id: existingWordId, pageNumber });
        }
      }

      word.placed = true;
      word.lockedBy = null;
      page.blanks[blank] = id; // Map blank position to word id
      io.emit('word_placed', { id, blank, pageNumber });
    }
  });

  // Remove word from blank (return to pool)
  socket.on('remove_word', ({ id }) => {
    const pageNumber = sharedState.userPages[socket.id];
    if (!pageNumber || !sharedState.pages[pageNumber]) return;

    const page = sharedState.pages[pageNumber];
    const word = page.pool.find(w => w.id === id);
    if (word && word.placed) {
      // Find which blank contains this word and clear it
      for (let blankPos in page.blanks) {
        if (page.blanks[blankPos] === id) {
          delete page.blanks[blankPos];
          break;
        }
      }
      word.placed = false;
      io.emit('word_removed', { id, pageNumber });
    }
  });

  // On disconnect, release any locks held by this socket
  socket.on('disconnect', () => {
    const pageNumber = sharedState.userPages[socket.id];
    if (pageNumber && sharedState.pages[pageNumber]) {
      sharedState.pages[pageNumber].pool.forEach(word => {
        if (word.lockedBy === socket.id && !word.placed) {
          word.lockedBy = null;
          io.emit('word_unlocked', { id: word.id, pageNumber });
        }
      });
    }
    // Clean up user page tracking
    delete sharedState.userPages[socket.id];
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
