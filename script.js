

'use strict';

//  Constants 
// Mutable so users can change durations at any time
let DURATIONS = {
  focus: 25 * 60,
  shortBreak: 5 * 60,
  longBreak: 15 * 60,
};
const LS_DURATIONS = 'ff_durations_v1';
const SESSIONS_BEFORE_LONG = 4;
const RING_CIRCUMFERENCE = 2 * Math.PI * 104.9; // r=104.9 → matches SVG

//  State 
let state = {
  mode: 'focus',    // 'focus' | 'shortBreak' | 'longBreak'
  timeLeft: DURATIONS.focus,
  totalTime: DURATIONS.focus,
  running: false,
  intervalId: null,
  sessionsDone: 0,          // completed focus sessions this cycle (resets after long break)
  activeTaskId: null,
  tasks: [],
  dailyPomodoros: 0,
  dailyDate: '',         // YYYY-MM-DD string for daily reset
};

//  DOM References 
const $ = id => document.getElementById(id);

const htmlEl = document.documentElement;
const timerDisplay = $('timerDisplay');
const sessionLabel = $('sessionLabel');
const sessionCounter = $('sessionCounter');
const ringProgress = $('ringProgress');
const ringContainer = document.querySelector('.timer-ring-container');
const startBtn = $('startBtn');
const startBtnText = $('startBtnText');
const resetBtn = $('resetBtn');
const skipBtn = $('skipBtn');
const settingsToggle = $('settingsToggle');
const settingsRow = $('settingsRow');
const inputFocus = $('inputFocus');
const inputShort = $('inputShort');
const inputLong = $('inputLong');
const workingOnTask = $('workingOnTask');
const taskInput = $('taskInput');
const addTaskBtn = $('addTaskBtn');
const taskList = $('taskList');
const emptyState = $('emptyState');
const taskActions = $('taskActions');
const tasksCount = $('tasksCount');
const clearCompleted = $('clearCompletedBtn');
const themeToggle = $('themeToggle');
const dailyBadge = $('dailyCount');
const footerPomodoros = $('footerPomodoros');
const focusTimeToday = $('focusTimeToday');
const toast = $('toast');
const modeTabs = document.querySelectorAll('.mode-tab');

//  Helpers 
function pad(n) { return String(n).padStart(2, '0'); }

function formatTime(secs) {
  return `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

//  LocalStorage 
const LS_TASKS = 'ff_tasks_v2';
const LS_DAILY = 'ff_daily_v2';
const LS_THEME = 'ff_theme';
// LS_DURATIONS is declared near top with DURATIONS

function saveTasks() {
  localStorage.setItem(LS_TASKS, JSON.stringify(state.tasks));
}

function loadTasks() {
  try {
    const raw = localStorage.getItem(LS_TASKS);
    state.tasks = raw ? JSON.parse(raw) : [];
  } catch { state.tasks = []; }
}

//  Custom Durations 
function saveDurations() {
  localStorage.setItem(LS_DURATIONS, JSON.stringify({
    focus: DURATIONS.focus / 60,
    shortBreak: DURATIONS.shortBreak / 60,
    longBreak: DURATIONS.longBreak / 60,
  }));
}

function loadDurations() {
  try {
    const raw = localStorage.getItem(LS_DURATIONS);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.focus >= 1) { DURATIONS.focus = d.focus * 60; inputFocus.value = d.focus; }
    if (d.shortBreak >= 1) { DURATIONS.shortBreak = d.shortBreak * 60; inputShort.value = d.shortBreak; }
    if (d.longBreak >= 1) { DURATIONS.longBreak = d.longBreak * 60; inputLong.value = d.longBreak; }
  } catch { /* use defaults */ }
}

// Apply a changed duration for a given mode
function applyDuration(mode, minutes) {
  const mins = Math.max(1, parseInt(minutes, 10) || 1);
  DURATIONS[mode] = mins * 60;
  saveDurations();
  // If we're currently on this mode and timer is NOT running, reset display
  if (state.mode === mode && !state.running) {
    state.timeLeft = DURATIONS[mode];
    state.totalTime = DURATIONS[mode];
    updateDisplay();
    updateRing();
  }
}

function toggleSettings() {
  const open = settingsRow.classList.toggle('hidden');
  settingsToggle.classList.toggle('active-settings', !open);
}

function saveDaily() {
  localStorage.setItem(LS_DAILY, JSON.stringify({
    date: state.dailyDate,
    count: state.dailyPomodoros,
  }));
}

function loadDaily() {
  try {
    const raw = localStorage.getItem(LS_DAILY);
    if (!raw) return;
    const d = JSON.parse(raw);
    const today = todayStr();
    if (d.date === today) {
      state.dailyDate = d.date;
      state.dailyPomodoros = d.count || 0;
    } else {
      // New day → reset
      state.dailyDate = today;
      state.dailyPomodoros = 0;
      saveDaily();
    }
  } catch {
    state.dailyDate = todayStr();
    state.dailyPomodoros = 0;
  }
}

// Audio
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

// Resume context (required after browser suspends it)
function resumeAudio() {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();
}

// Play a bell-chime sound using inharmonic partials (how real bells sound)
// partials: [1, 2.756, 5.404, 8.933] — characteristic bell overtone ratios
function strikeChime(ctx, fundamental, startTime, volume = 0.45) {
  const partials = [
    { ratio: 1, gain: 1.0 },
    { ratio: 2.756, gain: 0.5 },
    { ratio: 5.404, gain: 0.25 },
    { ratio: 8.933, gain: 0.12 },
  ];
  const decayTime = 1.8;

  partials.forEach(({ ratio, gain: g }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(fundamental * ratio, startTime);
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume * g, startTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + decayTime);
    osc.start(startTime);
    osc.stop(startTime + decayTime + 0.05);
  });
}

function playChime(type = 'focus') {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;

    if (type === 'focus') {
      // 3 ascending chime strikes — G4, B4, D5
      strikeChime(ctx, 392, now + 0.0, 0.5);
      strikeChime(ctx, 494, now + 0.55, 0.5);
      strikeChime(ctx, 587, now + 1.1, 0.55);
      strikeChime(ctx, 784, now + 1.65, 0.45);  // final high G5
    } else {
      // 2 softer descending strikes — E5, C5
      strikeChime(ctx, 659, now + 0.0, 0.4);
      strikeChime(ctx, 523, now + 0.6, 0.35);
    }

    // Browser notification as backup
    if (Notification.permission === 'granted') {
      const msg = type === 'focus'
        ? '✅ Focus session done! Time for a break.'
        : '⏰ Break over — back to focus!';
      new Notification('FocusFlow', { body: msg, icon: '' });
    }
  } catch (e) {
    console.warn('Audio error:', e);
  }
}

//  Ring Progress 
function updateRing() {
  const fraction = state.timeLeft / state.totalTime;
  const offset = RING_CIRCUMFERENCE * (1 - fraction);
  ringProgress.style.strokeDasharray = RING_CIRCUMFERENCE;
  ringProgress.style.strokeDashoffset = offset;
}

//  Timer Display 
const SESSION_META = {
  focus: { label: 'Focus Time', tab: 'tabFocus' },
  shortBreak: { label: 'Short Break', tab: 'tabShort' },
  longBreak: { label: 'Long Break', tab: 'tabLong' },
};

function updateDisplay() {
  timerDisplay.textContent = formatTime(state.timeLeft);
  sessionLabel.textContent = SESSION_META[state.mode].label;
  document.title = `${formatTime(state.timeLeft)} · FocusFlow`;

  const cycleSession = (state.sessionsDone % SESSIONS_BEFORE_LONG) + 1;
  const isFocus = state.mode === 'focus';
  const remaining = SESSIONS_BEFORE_LONG - (state.sessionsDone % SESSIONS_BEFORE_LONG);
  sessionCounter.textContent = isFocus
    ? `Session ${cycleSession} of ${SESSIONS_BEFORE_LONG}`
    : `${remaining} left until long break`;
}

function updateStartBtn() {
  const playIcon = startBtn.querySelector('.btn-play-icon');
  const pauseIcon = startBtn.querySelector('.btn-pause-icon');
  if (state.running) {
    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');
    startBtnText.textContent = 'Pause';
  } else {
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
    startBtnText.textContent = 'Start';
  }
  ringContainer.classList.toggle('running', state.running);
}

//  Mode switching 
function setMode(mode, resetTimer = true) {
  stopTimer();
  state.mode = mode;
  if (resetTimer) {
    state.timeLeft = DURATIONS[mode];
    state.totalTime = DURATIONS[mode];
  }
  htmlEl.dataset.mode = mode;

  // Update tabs
  modeTabs.forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
    t.setAttribute('aria-selected', t.dataset.mode === mode);
  });

  updateDisplay();
  updateRing();
  updateStartBtn();
}

//  Timer Core 
function startTimer() {
  if (state.running) return;
  resumeAudio();          // unlock AudioContext after user gesture
  state.running = true;
  state.intervalId = setInterval(tick, 1000);
  updateStartBtn();
}

function stopTimer() {
  state.running = false;
  clearInterval(state.intervalId);
  state.intervalId = null;
  updateStartBtn();
}

function tick() {
  if (state.timeLeft <= 0) {
    onTimerEnd();
    return;
  }
  state.timeLeft--;
  updateDisplay();
  updateRing();
}

function onTimerEnd() {
  stopTimer();

  if (state.mode === 'focus') {
    // Award pomodoro
    state.sessionsDone++;
    state.dailyPomodoros++;
    state.dailyDate = todayStr();
    saveDaily();

    // Award to active task
    if (state.activeTaskId) {
      const task = state.tasks.find(t => t.id === state.activeTaskId);
      if (task) { task.pomodoros++; saveTasks(); renderTasks(); }
    }

    updateDailyStats();
    playChime('focus');

    // Auto-switch
    if (state.sessionsDone % SESSIONS_BEFORE_LONG === 0) {
      showToast('🎉 Long break time! Great work!');
      setMode('longBreak');
    } else {
      showToast('✅ Focus done! Take a short break.');
      setMode('shortBreak');
    }
  } else {
    playChime('break');
    showToast('⏰ Break over — back to focus!');
    setMode('focus');
  }

  // Auto-start next phase
  startTimer();
}

function resetTimer() {
  stopTimer();
  state.timeLeft = DURATIONS[state.mode];
  state.totalTime = DURATIONS[state.mode];
  updateDisplay();
  updateRing();
}

function skipSession() {
  stopTimer();
  if (state.mode === 'focus') {
    state.sessionsDone++;
    if (state.sessionsDone % SESSIONS_BEFORE_LONG === 0) {
      setMode('longBreak');
    } else {
      setMode('shortBreak');
    }
  } else {
    setMode('focus');
  }
  startTimer();
}

//  Daily Stats 
function updateDailyStats() {
  const count = state.dailyPomodoros;
  dailyBadge.textContent = count;
  footerPomodoros.textContent = `${count} pomodoro${count !== 1 ? 's' : ''} completed`;
  focusTimeToday.textContent = `${count * 25} min focused today`;
}

//  Task Manager 
function addTask(name) {
  name = name.trim();
  if (!name) return;
  const task = { id: uid(), name, completed: false, pomodoros: 0 };
  state.tasks.unshift(task);
  saveTasks();
  renderTasks();
  showToast(`📝 Task added: "${name.slice(0, 30)}"`);
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  if (state.activeTaskId === id) {
    state.activeTaskId = null;
    workingOnTask.textContent = 'No task selected';
  }
  saveTasks();
  renderTasks();
}

function toggleComplete(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  task.completed = !task.completed;
  if (task.completed && state.activeTaskId === id) {
    state.activeTaskId = null;
    workingOnTask.textContent = 'No task selected';
  }
  saveTasks();
  renderTasks();
}

function selectTask(id) {
  if (state.activeTaskId === id) {
    state.activeTaskId = null;
    workingOnTask.textContent = 'No task selected';
  } else {
    state.activeTaskId = id;
    const task = state.tasks.find(t => t.id === id);
    workingOnTask.textContent = task ? task.name : 'No task selected';
  }
  renderTasks();
}

function clearCompletedTasks() {
  state.tasks = state.tasks.filter(t => !t.completed);
  if (state.activeTaskId) {
    const still = state.tasks.find(t => t.id === state.activeTaskId);
    if (!still) {
      state.activeTaskId = null;
      workingOnTask.textContent = 'No task selected';
    }
  }
  saveTasks();
  renderTasks();
}

//  Render Tasks 
function renderTasks() {
  taskList.innerHTML = '';

  const hasTasks = state.tasks.length > 0;
  emptyState.classList.toggle('hidden', hasTasks);
  taskActions.classList.toggle('hidden', !hasTasks);

  const plural = state.tasks.length === 1 ? 'task' : 'tasks';
  tasksCount.textContent = `${state.tasks.length} ${plural}`;

  state.tasks.forEach(task => {
    const li = document.createElement('li');
    li.className = 'task-item';
    if (task.completed) li.classList.add('completed');
    if (task.id === state.activeTaskId) li.classList.add('active-task');
    li.setAttribute('role', 'listitem');

    // Checkbox
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'task-checkbox';
    cb.checked = task.completed;
    cb.id = `cb-${task.id}`;
    cb.setAttribute('aria-label', `Mark "${task.name}" as complete`);
    cb.addEventListener('click', e => { e.stopPropagation(); toggleComplete(task.id); });

    // Info
    const info = document.createElement('div');
    info.className = 'task-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'task-name';
    nameEl.textContent = task.name;
    nameEl.title = task.name;

    const pomEl = document.createElement('div');
    pomEl.className = 'task-pomodoros';
    pomEl.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      ${task.pomodoros} pomodoro${task.pomodoros !== 1 ? 's' : ''}`;

    info.appendChild(nameEl);
    info.appendChild(pomEl);

    // Delete btn
    const del = document.createElement('button');
    del.className = 'task-delete';
    del.setAttribute('aria-label', `Delete task: ${task.name}`);
    del.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
    del.addEventListener('click', e => { e.stopPropagation(); deleteTask(task.id); });

    li.appendChild(cb);
    li.appendChild(info);
    li.appendChild(del);

    // Click row → select task (if not completed)
    li.addEventListener('click', () => {
      if (!task.completed) selectTask(task.id);
    });

    taskList.appendChild(li);
  });
}

//  Toast 
let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

//  Theme 
function applyTheme(theme) {
  htmlEl.dataset.theme = theme;
  localStorage.setItem(LS_THEME, theme);
}

function loadTheme() {
  const saved = localStorage.getItem(LS_THEME);
  const system = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(saved || system);
}

//  Event Listeners 
startBtn.addEventListener('click', () => {
  if (state.running) stopTimer();
  else startTimer();
});

resetBtn.addEventListener('click', resetTimer);
skipBtn.addEventListener('click', skipSession);

modeTabs.forEach(tab => {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
});

addTaskBtn.addEventListener('click', () => {
  addTask(taskInput.value);
  taskInput.value = '';
  taskInput.focus();
});

taskInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    addTask(taskInput.value);
    taskInput.value = '';
  }
});

clearCompleted.addEventListener('click', clearCompletedTasks);

// Settings toggle
settingsToggle.addEventListener('click', toggleSettings);

// Duration inputs — apply on change/Enter
function makeDurationHandler(mode, input) {
  const apply = () => {
    const v = Math.max(1, parseInt(input.value, 10) || 1);
    input.value = v;          // clamp display value
    applyDuration(mode, v);
    showToast(`⏱ ${SESSION_META[mode].label} set to ${v} min`);
  };
  input.addEventListener('change', apply);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { apply(); input.blur(); } });
}
makeDurationHandler('focus', inputFocus);
makeDurationHandler('shortBreak', inputShort);
makeDurationHandler('longBreak', inputLong);

themeToggle.addEventListener('click', () => {
  const next = htmlEl.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  showToast(next === 'dark' ? '🌙 Dark mode enabled' : '☀️ Light mode enabled');
});

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  if (!localStorage.getItem(LS_THEME)) {
    applyTheme(e.matches ? 'dark' : 'light');
  }
});

// Daily reset check — runs every minute
setInterval(() => {
  if (state.dailyDate !== todayStr()) {
    state.dailyPomodoros = 0;
    state.dailyDate = todayStr();
    saveDaily();
    updateDailyStats();
  }
}, 60_000);

// Init

function init() {
  loadTheme();
  loadTasks();
  loadDaily();
  loadDurations();   // must be before setMode so timers use saved values

  // Set initial data-mode on html
  htmlEl.dataset.mode = state.mode;

  setMode('focus', true);
  renderTasks();
  updateDailyStats();

  // Set ring circumference once
  ringProgress.style.strokeDasharray = RING_CIRCUMFERENCE;
  updateRing();

  // Request notification permission (for backup browser notifications)
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

init();
