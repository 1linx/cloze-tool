// WebSocket-enabled Cloze test tool
(function(){
  const sentencesRoot = document.getElementById('sentences');
  const wordsRoot = document.getElementById('words');
  let selectedId = null; // for tap-to-select on mobile

  // --- WebSocket setup ---
  let socket = null;
  let wsState = {
    pool: [],
    blanks: {},
    sentences: [],
    title: '',
    instructions: '',
    totalPages: 1,
    currentPage: 1,
    isAdmin: false,
    unlockedWords: {}
  };
  let adminToken = null;

  function clearSelection(){
    selectedId = null;
    const prev = document.querySelector('.word-item.selected');
    if(prev) prev.classList.remove('selected');
  }

  function connectSocket(){
    socket = io();

    socket.on('connect', () => {
      console.log('Connected to server');
    });

    socket.on('state', (state) => {
      console.log('Received state:', state);
      wsState = {
        pool: state.pool,
        blanks: state.blanks,
        sentences: state.sentences,
        title: state.title,
        instructions: state.instructions,
        totalPages: state.totalPages,
        currentPage: state.currentPage,
        isAdmin: state.isAdmin || false,
        unlockedWords: state.unlockedWords || {}
      };

      // Update dynamic title and instructions
      const titleEl = document.getElementById('app-title');
      const instrEl = document.getElementById('app-instructions');
      if(titleEl && state.title) titleEl.textContent = state.title;
      if(instrEl && state.instructions) instrEl.textContent = state.instructions;

      updateAdminUI();
      updatePageNavigation();
      renderFromState();
    });

    socket.on('page_state', (pageState) => {
      console.log('Received page_state:', pageState);
      wsState.currentPage = pageState.pageNumber;
      wsState.pool = pageState.pool;
      wsState.blanks = pageState.blanks;
      wsState.sentences = pageState.sentences;
      wsState.totalPages = pageState.totalPages;
      wsState.isAdmin = pageState.isAdmin || wsState.isAdmin;
      wsState.unlockedWords = pageState.unlockedWords || {};

      clearSelection();
      updatePageNavigation();
      renderFromState();
    });

    // Admin authentication success
    socket.on('admin_authenticated', (data) => {
      wsState.isAdmin = true;
      wsState.pool = data.pool;
      wsState.unlockedWords = data.unlockedWords;
      adminToken = data.token || adminToken;
      updateAdminUI();
      renderFromState();
      hideAdminModal();
    });

    // Admin authentication failed
    socket.on('admin_auth_failed', () => {
      showAdminError('Invalid password');
    });

    // Admin word unlock confirmed
    socket.on('word_unlock_confirmed', ({ wordId }) => {
      wsState.unlockedWords[wordId] = true;
      renderFromState();
    });

    // Non-admin: word unlocked by admin
    socket.on('word_unlocked_by_admin', ({ word }) => {
      // Add word to pool
      wsState.pool.push(word);
      renderFromState();
    });

    socket.on('word_locked', ({ id, by, pageNumber }) => {
      // Filter by page - only process if it's for the current page
      if (pageNumber !== wsState.currentPage) return;

      const word = wsState.pool.find(w => w.id === id);
      if(word){
        word.lockedBy = by;
        renderFromState();
      }
    });

    socket.on('word_unlocked', ({ id, pageNumber }) => {
      // Filter by page - only process if it's for the current page
      if (pageNumber !== wsState.currentPage) return;

      const word = wsState.pool.find(w => w.id === id);
      if(word){
        word.lockedBy = null;
        renderFromState();
      }
    });

    socket.on('word_placed', ({ id, blank, pageNumber }) => {
      // Filter by page - only process if it's for the current page
      if (pageNumber !== wsState.currentPage) return;

      const word = wsState.pool.find(w => w.id === id);
      if(word){
        word.placed = true;
        word.lockedBy = null;
        wsState.blanks[blank] = id; // Map blank position to word id
        clearSelection(); // Deselect after placing
        renderFromState();
      }
    });

    socket.on('word_removed', ({ id, pageNumber }) => {
      // Filter by page - only process if it's for the current page
      if (pageNumber !== wsState.currentPage) return;

      const word = wsState.pool.find(w => w.id === id);
      if(word){
        word.placed = false;
        // Remove this word from whichever blank contains it
        for(let blankPos in wsState.blanks){
          if(wsState.blanks[blankPos] === id){
            delete wsState.blanks[blankPos];
            break;
          }
        }
        renderFromState();
      }
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from server');
    });

    socket.on('reset', () => {
      console.log('Exercise reset');
      // Reset local state
      wsState.pool.forEach(word => {
        word.placed = false;
        word.lockedBy = null;
      });
      wsState.blanks = {};
      clearSelection();
      renderFromState();
    });
  }

  // --- Utility: check if all blanks are filled correctly ---
  function isComplete(){
    const sentences = wsState.sentences || [];
    const pool = wsState.pool || [];
    const blanks = wsState.blanks || {};
    let blankCount = 0;

    for(let si = 0; si < sentences.length; si++){
      const s = sentences[si];
      for(let ti = 0; ti < s.tokens.length; ti++){
        if(s.tokens[ti] === null){ // It's a blank
          blankCount++;
          const blankPos = `${si}-${ti}`;
          const wordId = blanks[blankPos];
          if(!wordId) return false; // Blank not filled

          const placedWord = pool.find(w => w.id === wordId);
          if(!placedWord) return false; // Should not happen

          // Find the solution word text for this blank
          const solutionWord = pool.find(p => p.sentenceIndex === si && p.tokenIndex === ti);
          if (!solutionWord) return false; // Should not happen

          if(placedWord.word !== solutionWord.word){
            return false; // The text of the placed word doesn't match the solution text for this blank
          }
        }
      }
    }
    // If we get here, all blanks are filled and the word texts are correct.
    // Return true only if there were actually blanks to fill.
    return blankCount > 0;
  }

  // --- Progress message updater ---
  function updateProgressMessage(){
    const messageEl = document.getElementById('message');
    const blanks = Array.from(document.querySelectorAll('.blank'));

    if(!blanks.length){
      if(messageEl){
        messageEl.classList.remove('show', 'success', 'error');
        messageEl.textContent = '';
      }
      return;
    }

    // Check if all blanks are filled
    const allFilled = blanks.every(b => b.dataset.filledId);

    if(messageEl){
      if(allFilled){
        // All blanks are filled - check if correct
        if(isComplete()){
          // All correct
          messageEl.textContent = 'Complete';
          messageEl.classList.remove('error');
          messageEl.classList.add('show', 'success');
        } else {
          // All filled but some incorrect
          messageEl.textContent = 'Two or more words are incorrect.';
          messageEl.classList.remove('success');
          messageEl.classList.add('show', 'error');
        }
      } else {
        // Not all filled yet
        const emptyCount = blanks.filter(b => !b.dataset.filledId).length;
        if(emptyCount === 1 || emptyCount === 2){
          messageEl.textContent = 'Almost finished';
          messageEl.classList.remove('success', 'error');
          messageEl.classList.add('show');
        } else {
          messageEl.classList.remove('show', 'success', 'error');
          messageEl.textContent = '';
        }
      }
    }
  }

  // --- Drop handler for blank ---
  function onDropToBlank(e){
    if(isComplete()) return;
    e.preventDefault();
    this.classList.remove('dragover');

    const id = e.dataTransfer.getData('text/plain');
    const item = wsState.pool.find(p=>p.id===id);
    if(!item) return;

    // Get blank position
    const si = Number(this.dataset.sentence);
    const ti = Number(this.dataset.token);
    const blank = `${si}-${ti}`;

    // If blank already has a word, return it to pool first
    const existingId = this.dataset.filledId;
    if(existingId){
      socket.emit('remove_word', { id: existingId });
    }

    // Place this word
    socket.emit('place_word', { id, blank });
  }

  // --- Place item in blank (for click/tap) ---
  function placeItemInBlank(item, blankEl){
    if(isComplete()) return;

    const si = Number(blankEl.dataset.sentence);
    const ti = Number(blankEl.dataset.token);
    const blank = `${si}-${ti}`;

    // If blank already has a word, return it to pool first
    const existingId = blankEl.dataset.filledId;
    if(existingId){
      socket.emit('remove_word', { id: existingId });
    }

    // Place this word
    socket.emit('place_word', { id: item.id, blank });
  }

  // --- Render UI from wsState ---
  function renderFromState(){
    const sentences = wsState.sentences || [];
    const pool = wsState.pool || [];

    // Render sentences
    sentencesRoot.innerHTML = '';
    sentences.forEach((s, si)=>{
      const div = document.createElement('div');
      div.className = 'sentence';

      s.tokens.forEach((t, ti)=>{
        if(t === null){
          const span = document.createElement('span');
          span.className = 'blank';
          span.dataset.sentence = si;
          span.dataset.token = ti;

          // Find which word (if any) is placed in this blank position
          const blankPos = `${si}-${ti}`;
          const wordId = wsState.blanks[blankPos];
          const word = wordId ? pool.find(w => w.id === wordId) : null;

          if(word){
            span.textContent = word.word;
            span.classList.add('filled');
            span.dataset.filledId = word.id;
          } else {
            span.textContent = '';
            delete span.dataset.filledId;
          }

          // Drag/drop handlers
          if(!isComplete()){
            span.addEventListener('dragover', e=>{ e.preventDefault(); });
            span.addEventListener('dragenter', e=>{
              e.preventDefault();
              span.classList.add('dragover');
            });
            span.addEventListener('dragleave', e=>{
              span.classList.remove('dragover');
            });
            span.addEventListener('drop', onDropToBlank);
          }

          div.appendChild(span);
        } else {
          const span = document.createElement('span');
          span.className = 'token';
          span.textContent = t + ' ';
          div.appendChild(span);
        }
      });

      sentencesRoot.appendChild(div);
    });

    // Render word bank
    wordsRoot.innerHTML = '';
    const complete = isComplete();

    pool.forEach(item=>{
      if(item.placed) return; // skip placed words

      const w = document.createElement('div');
      w.className = 'word-item';
      w.textContent = item.word;
      w.id = item.id;
      w.dataset.word = item.word;

      if(item.id === selectedId){
        w.classList.add('selected');
      }

      // Admin mode: mark unlocked words
      if(wsState.isAdmin){
        const isUnlocked = wsState.unlockedWords[item.id];
        if(isUnlocked){
          w.classList.add('admin-unlocked');
          w.title = 'Unlocked for students';
        } else {
          w.classList.add('admin-locked');
          w.title = 'Click to unlock for students';
        }
      }

      const isLocked = item.lockedBy && item.lockedBy !== socket.id;
      w.draggable = !complete && !isLocked && !wsState.isAdmin;

      if(isLocked){
        w.classList.add('locked');
        w.title = 'Word is being used by another user';
      }

      if(!complete && !isLocked){
        // Admin mode: click to unlock
        if(wsState.isAdmin){
          w.addEventListener('click', e=>{
            e.preventDefault();
            const isUnlocked = wsState.unlockedWords[item.id];
            if(!isUnlocked){
              socket.emit('admin_unlock_word', { wordId: item.id });
            }
          });
        } else {
          // Regular user mode: drag and select
          // Drag start
          w.addEventListener('dragstart', e=>{
            socket.emit('select_word', { id: item.id });
            e.dataTransfer.setData('text/plain', item.id);
            e.dataTransfer.effectAllowed = 'move';
          });

          // Click to select
          w.addEventListener('click', e=>{
            e.preventDefault();
            if(selectedId === item.id){
              socket.emit('release_word', { id: item.id });
              clearSelection();
              return;
            }
            clearSelection();
            selectedId = item.id;
            w.classList.add('selected');
            socket.emit('select_word', { id: item.id });
          });

          // Touch to select
          w.addEventListener('touchstart', e=>{
            e.preventDefault();
            if(selectedId === item.id){
              socket.emit('release_word', { id: item.id });
              clearSelection();
              return;
            }
            clearSelection();
            selectedId = item.id;
            w.classList.add('selected');
            socket.emit('select_word', { id: item.id });
          }, {passive:false});
        }
      }

      wordsRoot.appendChild(w);
    });

    updateProgressMessage();
  }

  // --- Make wordbank droppable so users can drag words back ---
  const wordbank = document.getElementById('wordbank');
  wordbank.addEventListener('dragover', e=>e.preventDefault());
  wordbank.addEventListener('drop', e=>{
    if(isComplete()) return;
    e.preventDefault();

    const id = e.dataTransfer.getData('text/plain');
    const item = wsState.pool.find(p=>p.id===id);
    if(!item) return;

    // If the word was placed in a blank, remove it
    if(item.placed){
      socket.emit('remove_word', { id });
    }
  });

  // --- Allow clicking a blank ---
  document.addEventListener('click', e=>{
    if(isComplete()) return;
    const b = e.target.closest('.blank');
    if(!b) return;

    if(selectedId){
      // Place the selected word here
      const item = wsState.pool.find(p=>p.id===selectedId);
      if(item){
        placeItemInBlank(item, b);
      }
      return;
    }

    // No selection: if blank filled, return word to bank
    if(b.dataset.filledId){
      const id = b.dataset.filledId;
      socket.emit('remove_word', { id });
    }
  });

  // --- Reset button handler ---
  const resetBtn = document.getElementById('resetBtn');
  if(resetBtn){
    resetBtn.addEventListener('click', async () => {
      if(confirm('Reset the exercise? This will clear all placements for all users.')){
        try {
          const response = await fetch('/api/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          if(!response.ok){
            console.error('Failed to reset');
          }
        } catch(err){
          console.error('Error resetting:', err);
        }
      }
    });
  }

  // --- Page navigation functions ---
  function initPageNavigation() {
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (wsState.currentPage > 1) {
          socket.emit('change_page', { pageNumber: wsState.currentPage - 1 });
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (wsState.currentPage < wsState.totalPages) {
          socket.emit('change_page', { pageNumber: wsState.currentPage + 1 });
        }
      });
    }
  }

  function updatePageNavigation() {
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    const indicator = document.getElementById('page-indicator');

    if (prevBtn) {
      prevBtn.disabled = wsState.currentPage <= 1;
    }

    if (nextBtn) {
      nextBtn.disabled = wsState.currentPage >= wsState.totalPages;
    }

    if (indicator) {
      indicator.textContent = `Page ${wsState.currentPage} of ${wsState.totalPages}`;
    }
  }

  // --- Admin UI functions ---
  function updateAdminUI() {
    const adminIndicator = document.getElementById('adminModeIndicator');
    const adminBtn = document.getElementById('adminBtn');
    const resetBtn = document.getElementById('resetBtn');

    if (wsState.isAdmin) {
      if (adminIndicator) adminIndicator.style.display = 'flex';
      if (adminBtn) adminBtn.style.display = 'none';
      if (resetBtn) resetBtn.style.display = 'inline-block';
    } else {
      if (adminIndicator) adminIndicator.style.display = 'none';
      if (adminBtn) adminBtn.style.display = 'inline-block';
      if (resetBtn) resetBtn.style.display = 'none';
    }
  }

  function showAdminModal() {
    const modal = document.getElementById('adminModal');
    const passwordInput = document.getElementById('adminPassword');
    const errorDiv = document.getElementById('adminError');
    if (modal) modal.style.display = 'flex';
    if (passwordInput) {
      passwordInput.value = '';
      passwordInput.focus();
    }
    if (errorDiv) errorDiv.textContent = '';
  }

  function hideAdminModal() {
    const modal = document.getElementById('adminModal');
    if (modal) modal.style.display = 'none';
  }

  function showAdminError(message) {
    const errorDiv = document.getElementById('adminError');
    if (errorDiv) errorDiv.textContent = message;
  }

  async function handleAdminLogin() {
    const passwordInput = document.getElementById('adminPassword');
    const password = passwordInput ? passwordInput.value : '';

    if (!password) {
      showAdminError('Please enter a password');
      return;
    }

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        adminToken = data.token;
        // Send token to socket
        socket.emit('admin_login', { token: data.token });
      } else {
        showAdminError(data.error || 'Login failed');
      }
    } catch (err) {
      console.error('Admin login error:', err);
      showAdminError('Connection error');
    }
  }

  // --- Admin button handlers ---
  const adminBtn = document.getElementById('adminBtn');
  if (adminBtn) {
    adminBtn.addEventListener('click', showAdminModal);
  }

  const adminLoginBtn = document.getElementById('adminLoginBtn');
  if (adminLoginBtn) {
    adminLoginBtn.addEventListener('click', handleAdminLogin);
  }

  const adminCancelBtn = document.getElementById('adminCancelBtn');
  if (adminCancelBtn) {
    adminCancelBtn.addEventListener('click', hideAdminModal);
  }

  const adminPassword = document.getElementById('adminPassword');
  if (adminPassword) {
    adminPassword.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        handleAdminLogin();
      }
    });
  }

  // Initialize
  connectSocket();
  initPageNavigation();
})();
