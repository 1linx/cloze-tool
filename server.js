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

// Reset endpoint - reloads data.json and broadcasts to all clients
app.post('/api/reset', (req, res) => {
  sharedState = loadSharedState(); // Reload data

  // Notify all connected clients of the new state
  io.sockets.sockets.forEach(socket => {
    const userPool = [...sharedState.pool];
    for (let i = userPool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [userPool[i], userPool[j]] = [userPool[j], userPool[i]];
    }

    socket.emit('state', {
        title: sharedState.title,
        instructions: sharedState.instructions,
        sentences: sharedState.sentences,
        pool: userPool,
        blanks: sharedState.blanks
    });
  });

  res.json({ ok: true, message: 'Exercise reset successfully' });
});

// --- Business logic: load and parse data ---
function loadSharedState() {
  const dataPath = path.join(__dirname, 'data.json');
  let rawData;
  try {
    rawData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (err) {
    console.error("Error reading data.json:", err);
    rawData = { title: "Error", instructions: "Could not load data.", sentences: [] };
  }

  const sentences = [];
  const pool = [];
  const blanks = {};

  rawData.sentences.forEach((line, si) => {
    const tokens = [];
    // Split by brackets, keeping the delimiters
    const parts = line.split(/(\[\[.*?\]\])/);

    parts.forEach(part => {
      if (part.startsWith('[[') && part.endsWith(']]')) {
        // It's a blank: [[word]]
        const word = part.slice(2, -2);
        pool.push({ id: `w-${si}-${tokens.length}`, word, sentenceIndex: si, tokenIndex: tokens.length, placed: false, lockedBy: null });
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

  return { sentences, pool, blanks, title: rawData.title, instructions: rawData.instructions };
}

// --- Shared state for all users (in-memory for now) ---
// This is reset on server restart. For production, use a DB or cache.
let sharedState = loadSharedState();

// API: get current state
app.get('/api/sentences', (req, res) => {
  // Return the current shared state (for new clients)
  // Only send minimal info needed for client
  res.json({
    title: sharedState.title,
    instructions: sharedState.instructions,
    sentences: sharedState.sentences,
    pool: sharedState.pool.map(({id, word, sentenceIndex, tokenIndex, placed, lockedBy}) => ({id, word, sentenceIndex, tokenIndex, placed, lockedBy}))
  });
});

// --- WebSocket logic ---
io.on('connection', (socket) => {
  // Create a shuffled version of the pool for this user
  const userPool = [...sharedState.pool];
  for (let i = userPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [userPool[i], userPool[j]] = [userPool[j], userPool[i]];
  }

  // Send current state to new client, with the shuffled pool
  socket.emit('state', {
    title: sharedState.title,
    instructions: sharedState.instructions,
    sentences: sharedState.sentences,
    pool: userPool,
    blanks: sharedState.blanks
  });

  // Word select (lock)
  socket.on('select_word', ({ id }) => {
    const wordToLock = sharedState.pool.find(w => w.id === id);

    // Ensure word exists, is not placed, and is not locked by another user
    if (!wordToLock || wordToLock.placed || (wordToLock.lockedBy && wordToLock.lockedBy !== socket.id)) {
      return;
    }

    // Find and unlock ALL other words locked by this user
    const previouslyLockedWords = sharedState.pool.filter(w => w.lockedBy === socket.id && w.id !== id);
    if (previouslyLockedWords.length > 0) {
      previouslyLockedWords.forEach(word => {
        word.lockedBy = null;
        io.emit('word_unlocked', { id: word.id });
      });
    }

    // Lock the new word, if it's not already locked by this user
    if (wordToLock.lockedBy !== socket.id) {
      wordToLock.lockedBy = socket.id;
      io.emit('word_locked', { id, by: socket.id });
    }
  });

  // Word release (unlock)
  socket.on('release_word', ({ id }) => {
    const word = sharedState.pool.find(w => w.id === id);
    if(word && word.lockedBy === socket.id && !word.placed){
      word.lockedBy = null;
      io.emit('word_unlocked', { id });
    }
  });

  // Place word in blank
  socket.on('place_word', ({ id, blank }) => {
    const word = sharedState.pool.find(w => w.id === id);
    if(word && word.lockedBy === socket.id && !word.placed){
      // Remove any existing word from this blank position
      const existingWordId = sharedState.blanks[blank];
      if(existingWordId){
        const existingWord = sharedState.pool.find(w => w.id === existingWordId);
        if(existingWord){
          existingWord.placed = false;
          io.emit('word_removed', { id: existingWordId });
        }
      }

      word.placed = true;
      word.lockedBy = null;
      sharedState.blanks[blank] = id; // Map blank position to word id
      io.emit('word_placed', { id, blank });
    }
  });

  // Remove word from blank (return to pool)
  socket.on('remove_word', ({ id }) => {
    const word = sharedState.pool.find(w => w.id === id);
    if(word && word.placed){
      // Find which blank contains this word and clear it
      for(let blankPos in sharedState.blanks){
        if(sharedState.blanks[blankPos] === id){
          delete sharedState.blanks[blankPos];
          break;
        }
      }
      word.placed = false;
      io.emit('word_removed', { id });
    }
  });

  // On disconnect, release any locks held by this socket
  socket.on('disconnect', () => {
    sharedState.pool.forEach(word => {
      if(word.lockedBy === socket.id && !word.placed){
        word.lockedBy = null;
        io.emit('word_unlocked', { id: word.id });
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
