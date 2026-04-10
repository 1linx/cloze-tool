// WebSocket-enabled Cloze test tool
(function(){
  const sentencesRoot = document.getElementById('sentences');
  const wordsRoot = document.getElementById('words');
  let selectedWord = null; // word text of selected item (tap-to-select)

  let socket = null;
  let wsState = {
    pool: [],        // [{ id: wordText, word: wordText }, ...] deduped
    blanks: {},      // { "si-ti": wordText }
    solution: {},    // { "si-ti": wordText } — correct answers
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
    selectedWord = null;
    const prev = document.querySelector('.word-item.selected');
    if(prev) prev.classList.remove('selected');
  }

  function connectSocket(){
    socket = io();

    socket.on('connect', () => {
      console.log('Connected to server');
      // Auto-login if a token was previously saved
      const savedToken = localStorage.getItem('adminToken');
      if (savedToken) {
        socket.emit('admin_login', { token: savedToken });
      }
    });

    socket.on('state', (state) => {
      console.log('Received state:', state);
      wsState = {
        pool: state.pool,
        blanks: state.blanks,
        solution: state.solution || {},
        sentences: state.sentences,
        title: state.title,
        instructions: state.instructions,
        totalPages: state.totalPages,
        currentPage: state.currentPage,
        isAdmin: state.isAdmin || false,
        unlockedWords: state.unlockedWords || {}
      };

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
      wsState.solution = pageState.solution || {};
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
      if (data.token) adminToken = data.token;
      if (adminToken) localStorage.setItem('adminToken', adminToken);
      updateAdminUI();
      renderFromState();
      hideAdminModal();
    });

    // Admin authentication failed
    socket.on('admin_auth_failed', () => {
      // Clear any stale saved token
      localStorage.removeItem('adminToken');
      adminToken = null;
      showAdminError('Invalid password');
    });

    // Admin: single word unlock confirmed
    socket.on('word_unlock_confirmed', ({ wordText }) => {
      wsState.unlockedWords[wordText] = true;
      renderFromState();
    });

    // Non-admin: single word unlocked by admin
    socket.on('word_unlocked_by_admin', ({ wordText }) => {
      if (!wsState.pool.find(w => w.word === wordText)) {
        wsState.pool.push({ id: wordText, word: wordText });
      }
      renderFromState();
    });

    // Non-admin: all words unlocked by admin
    socket.on('all_words_unlocked_by_admin', ({ words }) => {
      words.forEach(word => {
        if (!wsState.pool.find(w => w.word === word.word)) {
          wsState.pool.push(word);
        }
      });
      renderFromState();
    });

    // Admin: all words unlocked confirmed
    socket.on('all_words_unlocked', ({ unlockedWords }) => {
      wsState.unlockedWords = unlockedWords;
      renderFromState();
    });

    socket.on('word_placed', ({ wordText, blank, pageNumber }) => {
      if (pageNumber !== wsState.currentPage) return;
      wsState.blanks[blank] = wordText;
      clearSelection();
      renderFromState();
    });

    socket.on('word_removed', ({ blank, pageNumber }) => {
      if (pageNumber !== wsState.currentPage) return;
      delete wsState.blanks[blank];
      renderFromState();
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from server');
    });

    socket.on('reset', () => {
      console.log('Exercise reset');
      wsState.blanks = {};
      clearSelection();
      renderFromState();
    });
  }

  // --- Check if all blanks are filled correctly ---
  function isComplete(){
    const solution = wsState.solution || {};
    const blanks = wsState.blanks || {};
    const positions = Object.keys(solution);
    if (!positions.length) return false;
    for (const pos of positions) {
      if (blanks[pos] !== solution[pos]) return false;
    }
    return true;
  }

  // --- Progress message updater ---
  function updateProgressMessage(){
    const messageEl = document.getElementById('message');
    const blankEls = Array.from(document.querySelectorAll('.blank'));

    if(!blankEls.length){
      if(messageEl) messageEl.classList.remove('show', 'success', 'error');
      return;
    }

    if(messageEl){
      const allFilled = blankEls.every(b => b.dataset.filledWord);
      if(allFilled){
        if(isComplete()){
          messageEl.textContent = 'Complete';
          messageEl.classList.remove('error');
          messageEl.classList.add('show', 'success');
        } else {
          messageEl.textContent = 'Two or more words are incorrect.';
          messageEl.classList.remove('success');
          messageEl.classList.add('show', 'error');
        }
      } else {
        const emptyCount = blankEls.filter(b => !b.dataset.filledWord).length;
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

    const wordText = e.dataTransfer.getData('text/plain');
    if(!wordText) return;

    const si = Number(this.dataset.sentence);
    const ti = Number(this.dataset.token);
    const blank = `${si}-${ti}`;

    socket.emit('place_word', { wordText, blank });
  }

  // --- Place item in blank (click/tap) ---
  function placeItemInBlank(wordText, blankEl){
    if(isComplete()) return;
    const si = Number(blankEl.dataset.sentence);
    const ti = Number(blankEl.dataset.token);
    const blank = `${si}-${ti}`;
    socket.emit('place_word', { wordText, blank });
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

          const blankPos = `${si}-${ti}`;
          const wordText = wsState.blanks[blankPos];

          if(wordText){
            span.textContent = wordText;
            span.classList.add('filled');
            span.dataset.filledWord = wordText;
          } else {
            span.textContent = '';
            delete span.dataset.filledWord;
          }

          if(!isComplete()){
            span.addEventListener('dragover', e=>{ e.preventDefault(); });
            span.addEventListener('dragenter', e=>{
              e.preventDefault();
              span.classList.add('dragover');
            });
            span.addEventListener('dragleave', ()=>{
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

    // Render word bank — deduplicated pool, words always visible
    wordsRoot.innerHTML = '';
    const complete = isComplete();

    pool.forEach(item => {
      const w = document.createElement('div');
      w.className = 'word-item';
      w.textContent = item.word;
      w.id = `word-${item.word}`;
      w.dataset.word = item.word;

      if(item.word === selectedWord){
        w.classList.add('selected');
      }

      // Admin mode: mark unlocked words
      if(wsState.isAdmin){
        const isUnlocked = wsState.unlockedWords[item.word];
        if(isUnlocked){
          w.classList.add('admin-unlocked');
          w.title = 'Unlocked for students';
        } else {
          w.classList.add('admin-locked');
          w.title = 'Click to unlock for students';
        }
      }

      w.draggable = !complete && !wsState.isAdmin;

      if(!complete){
        if(wsState.isAdmin){
          w.addEventListener('click', e=>{
            e.preventDefault();
            if(!wsState.unlockedWords[item.word]){
              socket.emit('admin_unlock_word', { wordText: item.word });
            }
          });
        } else {
          // Drag start
          w.addEventListener('dragstart', e=>{
            e.dataTransfer.setData('text/plain', item.word);
            e.dataTransfer.effectAllowed = 'move';
          });

          // Click to select
          w.addEventListener('click', e=>{
            e.preventDefault();
            if(selectedWord === item.word){
              clearSelection();
              return;
            }
            clearSelection();
            selectedWord = item.word;
            w.classList.add('selected');
          });

          // Touch to select
          w.addEventListener('touchstart', e=>{
            e.preventDefault();
            if(selectedWord === item.word){
              clearSelection();
              return;
            }
            clearSelection();
            selectedWord = item.word;
            w.classList.add('selected');
          }, {passive:false});
        }
      }

      wordsRoot.appendChild(w);
    });

    updateProgressMessage();
  }

  // --- Wordbank drop: no-op (words always stay in bank) ---
  const wordbank = document.getElementById('wordbank');
  wordbank.addEventListener('dragover', e=>e.preventDefault());
  wordbank.addEventListener('drop', e=>{ e.preventDefault(); });

  // --- Click a blank to place selected word or clear it ---
  document.addEventListener('click', e=>{
    if(isComplete()) return;
    const b = e.target.closest('.blank');
    if(!b) return;

    if(selectedWord){
      placeItemInBlank(selectedWord, b);
      clearSelection();
      return;
    }

    // No selection: if blank filled, clear it
    if(b.dataset.filledWord){
      const si = b.dataset.sentence;
      const ti = b.dataset.token;
      socket.emit('remove_word', { blank: `${si}-${ti}` });
    }
  });

  // --- Reset button handler ---
  const resetBtn = document.getElementById('resetBtn');
  if(resetBtn){
    resetBtn.addEventListener('click', async () => {
      if(confirm('Reset the exercise? This will clear all placements for all users.')){
        try {
          const response = await fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
          if(!response.ok) console.error('Failed to reset');
        } catch(err){
          console.error('Error resetting:', err);
        }
      }
    });
  }

  // --- Page navigation ---
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
    if (prevBtn) prevBtn.disabled = wsState.currentPage <= 1;
    if (nextBtn) nextBtn.disabled = wsState.currentPage >= wsState.totalPages;
    if (indicator) indicator.textContent = `Page ${wsState.currentPage} of ${wsState.totalPages}`;
  }

  // --- Admin UI ---
  function updateAdminUI() {
    const adminIndicator = document.getElementById('adminModeIndicator');
    const adminBtn = document.getElementById('adminBtn');
    const resetBtn = document.getElementById('resetBtn');
    const unlockAllBtn = document.getElementById('unlockAllBtn');

    if (wsState.isAdmin) {
      if (adminIndicator) adminIndicator.style.display = 'flex';
      if (adminBtn) adminBtn.style.display = 'none';
      if (resetBtn) resetBtn.style.display = 'inline-block';
      if (unlockAllBtn) unlockAllBtn.style.display = 'block';
    } else {
      if (adminIndicator) adminIndicator.style.display = 'none';
      if (adminBtn) adminBtn.style.display = 'inline-block';
      if (resetBtn) resetBtn.style.display = 'none';
      if (unlockAllBtn) unlockAllBtn.style.display = 'none';
    }
  }

  function showAdminModal() {
    const modal = document.getElementById('adminModal');
    const passwordInput = document.getElementById('adminPassword');
    const errorDiv = document.getElementById('adminError');
    if (modal) modal.style.display = 'flex';
    if (passwordInput) { passwordInput.value = ''; passwordInput.focus(); }
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
    if (!password) { showAdminError('Please enter a password'); return; }

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await response.json();
      if (response.ok && data.success) {
        adminToken = data.token;
        localStorage.setItem('adminToken', adminToken);
        socket.emit('admin_login', { token: data.token });
      } else {
        showAdminError(data.error || 'Login failed');
      }
    } catch (err) {
      console.error('Admin login error:', err);
      showAdminError('Connection error');
    }
  }

  // Admin button handlers
  const adminBtn = document.getElementById('adminBtn');
  if (adminBtn) adminBtn.addEventListener('click', showAdminModal);

  const adminLoginBtn = document.getElementById('adminLoginBtn');
  if (adminLoginBtn) adminLoginBtn.addEventListener('click', handleAdminLogin);

  const adminCancelBtn = document.getElementById('adminCancelBtn');
  if (adminCancelBtn) adminCancelBtn.addEventListener('click', hideAdminModal);

  const adminPassword = document.getElementById('adminPassword');
  if (adminPassword) {
    adminPassword.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleAdminLogin();
    });
  }

  // Admin logout button
  const adminLogoutBtn = document.getElementById('adminLogoutBtn');
  if (adminLogoutBtn) {
    adminLogoutBtn.addEventListener('click', () => {
      localStorage.removeItem('adminToken');
      adminToken = null;
      wsState.isAdmin = false;
      updateAdminUI();
      // Re-request state from server as non-admin
      socket.emit('change_page', { pageNumber: wsState.currentPage });
    });
  }

  // Unlock All button (admin only)
  const unlockAllBtn = document.getElementById('unlockAllBtn');
  if (unlockAllBtn) {
    unlockAllBtn.addEventListener('click', () => {
      socket.emit('admin_unlock_all');
    });
  }

  // Initialize
  connectSocket();
  initPageNavigation();
})();
