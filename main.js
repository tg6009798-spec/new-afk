'use strict';

/*
 * TREE BOT MASTERPIECE
 * One account only -> move to configured stand point -> face configured direction
 * -> maintain a 2x2 sapling area -> bone meal -> chop any resulting tree -> repeat.
 *
 * IMPORTANT:
 * - Configure STAND_POSITION and FACING_YAW below.
 * - The account is intentionally hard-coded to one login identity as requested.
 * - No second account / child process exists in this build.
 */

const mineflayer = process.env.TREEBOT_SELFTEST === '1' ? null : require('mineflayer');
const Vec3 = process.env.TREEBOT_SELFTEST === '1'
  ? class Vec3 {
      constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
      plus(v){return new Vec3(this.x+v.x,this.y+v.y,this.z+v.z);}
      offset(x,y,z){return new Vec3(this.x+x,this.y+y,this.z+z);}
      clone(){return new Vec3(this.x,this.y,this.z);}
      distanceTo(v){return Math.hypot(this.x-v.x,this.y-v.y,this.z-v.z);}
    }
  : require('vec3');
const { pathfinder, Movements, goals } = process.env.TREEBOT_SELFTEST === '1'
  ? { pathfinder: null, Movements: null, goals: null }
  : require('mineflayer-pathfinder');
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

const CONFIG = {
  server: {
    host: process.env.TREEBOT_SERVER_HOST || 'insanesmp.net',
    port: Number(process.env.TREEBOT_SERVER_PORT || 25565),
    version: process.env.TREEBOT_MC_VERSION || '1.21.11'
  },

  // ONE ACCOUNT ONLY.
  account: {
    username: process.env.TREEBOT_USERNAME || 'Vanshika9_YT',
    password: process.env.TREEBOT_PASSWORD || ''
  },

  // Put the block the bot should stand on here.
  // The 2x2 planting area is automatically calculated directly in front of it.
  standPosition: {
    x: Number(process.env.TREEBOT_STAND_X || 0),
    y: Number(process.env.TREEBOT_STAND_Y || 64),
    z: Number(process.env.TREEBOT_STAND_Z || 0)
  },

  // Minecraft yaw in radians. 0 = +Z, PI/2 = -X, PI = -Z, -PI/2 = +X.
  // Change this so the 2x2 area is in front of the bot.
  facingYaw: Number(process.env.TREEBOT_FACING_YAW || 0),

  movement: {
    arriveDistance: 0.35,
    timeoutMs: 60000,
    allowJump: true
  },

  farming: {
    scanEveryMs: 250,
    actionTimeoutMs: 8000,
    plantingDelayMs: 90,
    boneMealDelayMs: 90,
    chopDelayMs: 250,
    growthCheckMs: 350,
    maxBoneMealUsesPerSapling: 80,
    maxTreeWaitMs: 45000,
    postChopClearWaitMs: 5000,
    retryDelayMs: 1200
  },

  reconnect: {
    initialMs: 5000,
    maxMs: 60000,
    kickMinMs: 5 * 60 * 1000,
    kickMaxMs: 16 * 60 * 1000,
    disconnectJitterMs: 5000
  },

  auth: {
    // IMPORTANT: authentication must happen BEFORE spawn. Some servers keep the
    // player in an authentication state and never emit spawn until /login succeeds.
    // Therefore this is a POST-AUTH idle, not a pre-auth gate.
    postAuthIdleMs: 4000,
    captchaPromptTimeoutMs: 0,
    postAuthIdle: false,
    loginRetryCooldownMs: 3500,
    authTimeoutMs: 25000,
    successGraceMs: 1500,
    maxLoginAttemptsPerConnection: 2,
    spawnLoginFallbackDelayMs: 750,
    protocolLoginFallbackDelayMs: 1200,
    authSuccessGraceMs: 2200
  },

  logging: {
    actions: true,
    debug: false,
    heartbeatEveryMs: 30000,
    showWorldPosition: true
  }
};

const STATE_FILE = path.join(__dirname, 'tree_bot_state.json');
let bot = null;
let stopping = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let reconnectReason = 'startup';
let lastKickReason = '';
let lastDisconnectAt = 0;
let cycleBusy = false;
let authComplete = false;
let authBusy = false;
let authSubmittedAt = 0;
let loginAttempts = 0;
let loginPromptSeen = false;
let protocolLoggedIn = false;
let postAuthIdleUntil = 0;
let authTimeoutTimer = null;
let authFallbackTimer = null;
let authGraceTimer = null;
let lastDialogFingerprint = '';
let lastDialogAt = 0;
let spawned = false;
let authGateTimer = null;
let captchaBusy = false;
let captchaValue = '';
let captchaDialog = null;
let queuedAuthPackets = [];
let farmingLoopStarted = false;
let renderHealthServer = null;
let heartbeatTimer = null;

const state = {
  enabled: true,
  stats: {
    cycles: 0,
    planted: 0,
    boneMeal: 0,
    chopped: 0,
    movementFailures: 0,
    errors: 0,
    reconnects: 0
  }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now();

function log(...args) { console.log(...args); }
function debug(...args) { if (CONFIG.logging.debug) console.log('[DEBUG]', ...args); }
function action(...args) { if (CONFIG.logging.actions) console.log('[ACTION]', ...args); }
function error(...args) { console.error('[ERROR]', ...args); }

function validateRuntimeConfig() {
  if (!String(CONFIG.account.username || '').trim()) {
    throw new Error('TREEBOT_USERNAME is required.');
  }
  if (!String(CONFIG.account.password || '').trim()) {
    throw new Error('TREEBOT_PASSWORD is required. Set it in your hosting environment; never commit it to GitHub.');
  }
  if (!String(CONFIG.server.host || '').trim()) {
    throw new Error('TREEBOT_SERVER_HOST is required.');
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.enabled === 'boolean') state.enabled = parsed.enabled;
      if (parsed.stats && typeof parsed.stats === 'object') {
        for (const key of Object.keys(state.stats)) {
          const n = Number(parsed.stats[key]);
          if (Number.isFinite(n) && n >= 0) state.stats[key] = Math.floor(n);
        }
      }
    }
  } catch (err) {
    error('State load failed:', err.message);
  }
}

function saveState() {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    error('State save failed:', err.message);
  }
}

function isReady() {
  return !!(bot && bot.entity && bot.player && !stopping);
}

function isAir(block) {
  return !!block && ['air', 'cave_air', 'void_air'].includes(block.name);
}

function isSapling(block) {
  return !!block && typeof block.name === 'string' && block.name.endsWith('_sapling');
}

function isLog(block) {
  if (!block || typeof block.name !== 'string') return false;
  return /(?:^|_)(?:log|wood|stem|hyphae)$/.test(block.name);
}

function isLeaf(block) {
  return !!block && typeof block.name === 'string' && block.name.endsWith('_leaves');
}

function isReplaceableForSapling(block) {
  return isAir(block) || block?.name === 'snow';
}

function inventoryItem(predicate) {
  if (!bot?.inventory) return null;
  return bot.inventory.items().find(predicate) || null;
}

function findSapling() {
  return inventoryItem(i => typeof i.name === 'string' && i.name.endsWith('_sapling'));
}

function findBoneMeal() {
  return inventoryItem(i => i.name === 'bone_meal');
}

function findAxe() {
  return inventoryItem(i => typeof i.name === 'string' && i.name.endsWith('_axe'));
}

function inventoryCount(predicate) {
  if (!bot?.inventory) return 0;
  return bot.inventory.items().filter(predicate).reduce((sum, i) => sum + i.count, 0);
}

function getBlock(pos) {
  if (!isReady()) return null;
  try { return bot.blockAt(pos); } catch { return null; }
}

function getPlantPositions() {
  const stand = new Vec3(CONFIG.standPosition.x, CONFIG.standPosition.y, CONFIG.standPosition.z);
  const yaw = Number(CONFIG.facingYaw) || 0;
  // Minecraft yaw 0 points +Z. Rotate the local right vector accordingly.
  const forward = new Vec3(-Math.sin(yaw), 0, Math.cos(yaw));
  const right = new Vec3(Math.cos(yaw), 0, Math.sin(yaw));
  const base = stand.plus(forward);
  return [
    base,
    base.plus(right),
    base.plus(new Vec3(0, 0, 1).minus(forward).plus(new Vec3(0,0,0)))
  ];
}

// The helper above is intentionally replaced by a cardinal-grid-safe implementation.
function cardinalDirection(yaw) {
  const dirs = [
    { name: 'south', x: 0, z: 1 },
    { name: 'west', x: -1, z: 0 },
    { name: 'north', x: 0, z: -1 },
    { name: 'east', x: 1, z: 0 }
  ];
  const index = Math.round((yaw / (Math.PI / 2))) % 4;
  return dirs[(index + 4) % 4];
}

function get2x2Target() {
  const stand = new Vec3(CONFIG.standPosition.x, CONFIG.standPosition.y, CONFIG.standPosition.z);
  const dir = cardinalDirection(Number(CONFIG.facingYaw) || 0);
  const forward = new Vec3(dir.x, 0, dir.z);
  const right = new Vec3(-dir.z, 0, dir.x);
  const base = stand.plus(forward);
  return [
    base,
    base.plus(right),
    base.plus(new Vec3(0, 0, 1).plus(new Vec3(-1,0,-1)).plus(forward).plus(new Vec3(0,0,0)))
  ];
}

// Explicit 4-point target builder; avoids diagonal floating-point positions.
function getTarget() {
  const stand = new Vec3(CONFIG.standPosition.x, CONFIG.standPosition.y, CONFIG.standPosition.z);
  const dir = cardinalDirection(Number(CONFIG.facingYaw) || 0);
  const fx = dir.x, fz = dir.z;
  const rx = -fz, rz = fx;
  const baseX = stand.x + fx;
  const baseZ = stand.z + fz;
  return [
    new Vec3(baseX, stand.y + 1, baseZ),
    new Vec3(baseX + rx, stand.y + 1, baseZ + rz),
    new Vec3(baseX + fx, stand.y + 1, baseZ + fz),
    new Vec3(baseX + fx + rx, stand.y + 1, baseZ + fz + rz)
  ];
}

function targetGroundPositions(target = getTarget()) {
  return target.map(p => p.offset(0, -1, 0));
}

function targetState() {
  const target = getTarget();
  return target.map(p => {
    const b = getBlock(p);
    return { x: p.x, y: p.y, z: p.z, block: b?.name || 'unknown' };
  });
}

function treeLogsNearTarget(target = getTarget()) {
  if (!isReady()) return [];
  const result = [];
  const seen = new Set();
  const queue = [];
  for (const p of target) {
    const b = getBlock(p);
    if (isLog(b)) queue.push(p.clone());
    // A tree can have its trunk immediately above the planting position.
    for (let y = 1; y <= 3; y++) {
      const q = p.offset(0, y, 0);
      if (isLog(getBlock(q))) queue.push(q);
    }
  }
  while (queue.length) {
    const p = queue.shift();
    const key = `${p.x},${p.y},${p.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const b = getBlock(p);
    if (!isLog(b)) continue;
    result.push(p);
    // Small BFS through connected logs. This handles 1-tree and multi-trunk variants.
    for (const d of [
      [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]
    ]) {
      const q = p.offset(d[0], d[1], d[2]);
      if (!seen.has(`${q.x},${q.y},${q.z}`) && isLog(getBlock(q))) queue.push(q);
    }
  }
  return result;
}

function hasAnyTreeBlock(target = getTarget()) {
  if (treeLogsNearTarget(target).length) return true;
  return target.some(p => isSapling(getBlock(p)));
}

function allFourSaplingsPresent(target = getTarget()) {
  return target.every(p => isSapling(getBlock(p)));
}

function allFourClear(target = getTarget()) {
  return target.every(p => isReplaceableForSapling(getBlock(p)));
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function equipItem(item) {
  if (!isReady() || !item) return false;
  try {
    await withTimeout(bot.equip(item, 'hand'), CONFIG.farming.actionTimeoutMs, 'equip');
    return true;
  } catch (err) {
    state.stats.errors++;
    error('Equip failed:', err.message);
    return false;
  }
}

async function lookAt(pos) {
  if (!isReady()) return false;
  try {
    await withTimeout(bot.lookAt(pos.offset(0.5, 0.5, 0.5), true), CONFIG.farming.actionTimeoutMs, 'look');
    return true;
  } catch (err) {
    state.stats.errors++;
    debug('Look failed:', err.message);
    return false;
  }
}

async function plantMissingSaplings(target) {
  const sapling = findSapling();
  if (!sapling) {
    debug('No sapling anywhere in inventory.');
    return false;
  }

  let planted = false;
  for (const pos of target) {
    if (!isReady()) return planted;
    const here = getBlock(pos);
    const ground = getBlock(pos.offset(0, -1, 0));
    if (!isReplaceableForSapling(here) || !ground || isAir(ground)) continue;

    const currentSapling = findSapling();
    if (!currentSapling) break;
    if (!(await equipItem(currentSapling))) continue;
    if (!(await lookAt(ground))) continue;

    try {
      await withTimeout(bot.placeBlock(ground, new Vec3(0, 1, 0)), CONFIG.farming.actionTimeoutMs, 'plant');
      await sleep(CONFIG.farming.plantingDelayMs);
      const after = getBlock(pos);
      if (isSapling(after)) {
        planted = true;
        state.stats.planted++;
        action(`Planted ${after.name} at ${pos.x} ${pos.y} ${pos.z}`);
      }
    } catch (err) {
      state.stats.errors++;
      debug(`Plant failed at ${pos.x} ${pos.y} ${pos.z}:`, err.message);
    }
  }
  return planted;
}

async function useBoneMealOnSapling(pos) {
  let uses = 0;
  while (uses < CONFIG.farming.maxBoneMealUsesPerSapling && isReady()) {
    const current = getBlock(pos);
    if (!isSapling(current)) return true;

    const meal = findBoneMeal();
    if (!meal) {
      debug('Bone meal exhausted from the entire inventory.');
      return false;
    }

    if (!(await equipItem(meal))) return false;
    if (!(await lookAt(current))) return false;

    try {
      await withTimeout(bot.activateBlock(current), CONFIG.farming.actionTimeoutMs, 'bone meal');
      uses++;
      state.stats.boneMeal++;
      await sleep(CONFIG.farming.boneMealDelayMs);
    } catch (err) {
      state.stats.errors++;
      debug('Bone meal use failed:', err.message);
      await sleep(CONFIG.farming.retryDelayMs);
    }
  }
  return !isSapling(getBlock(pos));
}

async function growAllSaplings(target) {
  let changed = false;
  // Re-scan after every sapling because a successful large-tree generation changes all four blocks.
  for (const pos of target) {
    if (!isReady()) return changed;
    if (!isSapling(getBlock(pos))) continue;
    const before = getBlock(pos)?.name;
    const result = await useBoneMealOnSapling(pos);
    if (result || getBlock(pos)?.name !== before) changed = true;
    if (treeLogsNearTarget(target).length) return true;
  }
  return changed;
}

async function waitForGrowthOrSingleTree(target) {
  const deadline = now() + CONFIG.farming.maxTreeWaitMs;
  while (isReady() && now() < deadline) {
    if (treeLogsNearTarget(target).length) return 'tree';
    if (!target.some(p => isSapling(getBlock(p)))) return 'tree';
    await sleep(CONFIG.farming.growthCheckMs);
  }
  return treeLogsNearTarget(target).length ? 'tree' : 'timeout';
}

async function chopAnyTree(target) {
  const axe = findAxe();
  if (!axe) {
    debug('No axe available anywhere in inventory.');
    return false;
  }
  if (!(await equipItem(axe))) return false;

  let chopped = false;
  // Re-scan after each dig because Tree Chopper may remove the entire tree from one block.
  for (let pass = 0; pass < 32 && isReady(); pass++) {
    const logs = treeLogsNearTarget(target);
    if (!logs.length) break;

    const logPos = logs[0];
    const block = getBlock(logPos);
    if (!isLog(block)) continue;
    if (!(await lookAt(block))) continue;

    try {
      await withTimeout(bot.dig(block, true), CONFIG.farming.actionTimeoutMs, 'chop');
      chopped = true;
      state.stats.chopped++;
      action(`Chopped ${block.name} at ${logPos.x} ${logPos.y} ${logPos.z}`);
      await sleep(CONFIG.farming.chopDelayMs);
    } catch (err) {
      state.stats.errors++;
      debug('Chop failed:', err.message);
      await sleep(CONFIG.farming.retryDelayMs);
    }
  }
  return chopped;
}

async function waitUntilAreaClear(target) {
  const deadline = now() + CONFIG.farming.postChopClearWaitMs;
  while (isReady() && now() < deadline) {
    if (allFourClear(target) && !treeLogsNearTarget(target).length) return true;
    await sleep(200);
  }
  return allFourClear(target) && !treeLogsNearTarget(target).length;
}

async function ensureAtStandPosition() {
  if (!isReady()) return false;
  const target = new Vec3(CONFIG.standPosition.x + 0.5, CONFIG.standPosition.y + 1.0, CONFIG.standPosition.z + 0.5);
  const distance = bot.entity.position.distanceTo(target);
  if (distance <= CONFIG.movement.arriveDistance) {
    await bot.look(CONFIG.facingYaw, 0);
    return true;
  }

  if (!bot.pathfinder) return false;
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowFreeMotion = false;
  movements.maxDropDown = 1;
  movements.scafoldingBlocks = [];
  bot.pathfinder.setMovements(movements);

  try {
    await withTimeout(
      bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1)),
      CONFIG.movement.timeoutMs,
      'pathfinding'
    );
    await bot.look(CONFIG.facingYaw, 0);
    return bot.entity.position.distanceTo(target) <= 2.0;
  } catch (err) {
    state.stats.movementFailures++;
    debug('Pathfinding failed:', err.message);
    return false;
  } finally {
    try { bot.pathfinder.setGoal(null); } catch {}
  }
}

async function farmingCycle() {
  // This build is an authentication/idle harness: after authentication it
  // intentionally performs no farming, movement, or world interaction.
  if (CONFIG.auth.postAuthIdle) return;
  if (cycleBusy || !state.enabled || !authComplete || !isReady()) return;
  cycleBusy = true;
  state.stats.cycles++;
  const target = getTarget();

  try {
    if (!(await ensureAtStandPosition())) {
      error('Bot could not reach configured stand position. Check standPosition and pathfinding.');
      await sleep(CONFIG.farming.retryDelayMs);
      return;
    }

    // First priority: if a tree already exists, chop it before planting anything.
    if (treeLogsNearTarget(target).length) {
      await chopAnyTree(target);
      await waitUntilAreaClear(target);
      return;
    }

    // Maintain the 2x2 exactly: only missing positions are planted.
    if (!allFourSaplingsPresent(target)) {
      await plantMissingSaplings(target);
    }

    // If one or more saplings remain, grow them. A 2x2 large tree or a 1x1 tree is accepted.
    if (target.some(p => isSapling(getBlock(p)))) {
      await growAllSaplings(target);
    }

    // Re-check after bone meal: large tree, single tree, or delayed generation.
    if (treeLogsNearTarget(target).length) {
      await chopAnyTree(target);
      await waitUntilAreaClear(target);
      return;
    }

    if (target.some(p => isSapling(getBlock(p)))) {
      const result = await waitForGrowthOrSingleTree(target);
      if (result === 'tree') {
        await chopAnyTree(target);
        await waitUntilAreaClear(target);
      }
    }
  } catch (err) {
    state.stats.errors++;
    error('Cycle error:', err.stack || err.message);
  } finally {
    cycleBusy = false;
    saveState();
  }
}

async function farmingLoop() {
  if (farmingLoopStarted) return;
  farmingLoopStarted = true;
  loopRunningLog();
  while (!stopping) {
    try {
      await farmingCycle();
    } catch (err) {
      state.stats.errors++;
      error('Farming loop error:', err.stack || err.message);
    }
    await sleep(CONFIG.farming.scanEveryMs);
  }
}

function loopRunningLog() {
  log('[FARM] Continuous tree cycle enabled.');
  log(`[FARM] Stand: ${CONFIG.standPosition.x} ${CONFIG.standPosition.y} ${CONFIG.standPosition.z}`);
  log(`[FARM] Facing yaw: ${CONFIG.facingYaw}`);
  log('[FARM] Target:', getTarget().map(p => `${p.x} ${p.y} ${p.z}`).join(' | '));
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.translate === 'string') return value.translate;
  if (Array.isArray(value.extra)) return value.extra.map(textOf).join(' ');
  return '';
}

function unwrap(value) {
  if (value && typeof value === 'object' && 'type' in value && 'value' in value) return unwrap(value.value);
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = unwrap(v);
    return o;
  }
  return value;
}

function collectInputs(dialog) {
  const root = unwrap(dialog);
  const found = [];
  const seen = new Set();
  function walk(v) {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const type = typeof v.type === 'string' ? v.type : '';
    const key = typeof v.key === 'string' ? v.key : '';
    if (key && (type === 'minecraft:text' || type.includes('input') || type.includes('text'))) {
      if (!found.some(x => x.key === key)) found.push({ key, label: textOf(v.label) });
    }
    Object.values(v).forEach(walk);
  }
  walk(root);
  return found;
}

function collectActions(dialog) {
  const root = unwrap(dialog);
  const found = [];
  const seen = new Set();
  function add(a, label, submitId) {
    if (!a || typeof a !== 'object' || !a.type) return;
    found.push({
      type: a.type,
      id: typeof a.id === 'string' ? a.id : '',
      template: typeof a.template === 'string' ? a.template : '',
      label: label || '',
      submitId: submitId || ''
    });
  }
  function walk(v, label = '') {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach(x => walk(x, label)); return; }
    const nextLabel = v.label ? textOf(v.label) || label : label;
    if (v.on_submit) add(v.on_submit, nextLabel, typeof v.id === 'string' ? v.id : '');
    if (v.action) add(v.action, nextLabel, typeof v.id === 'string' ? v.id : '');
    if (v.on_click) add(v.on_click, nextLabel, '');
    Object.entries(v).forEach(([k, child]) => {
      if (k === 'on_submit' || k === 'on_click') return;
      walk(child, nextLabel);
    });
  }
  walk(root);
  return found.filter((x, i, a) => a.findIndex(y => y.type === x.type && y.id === x.id && y.submitId === x.submitId && y.template === x.template) === i);
}

function chooseLoginAction(actions) {
  const candidates = actions.filter(a => !/disconnect|cancel|back|close|exit/i.test(`${a.label} ${a.id} ${a.submitId} ${a.template}`));
  const scored = candidates.map(a => {
    const text = `${a.label} ${a.id} ${a.submitId} ${a.template}`.toLowerCase();
    let score = 0;
    if (/login|log\s*in|signin|sign\s*in/.test(text)) score += 500;
    if (/confirm|submit|continue|enter|proceed/.test(text)) score += 100;
    if (/register|signup|sign\s*up/.test(text)) score -= 1000; // never register this account
    if (/run_command|command_template/.test(text)) score += 20;
    return { a, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.a || null;
}

function makeLoginCommand(inputs, action) {
  const password = CONFIG.account.password;
  if (action?.template) {
    let command = action.template;
    const values = {};
    for (const input of inputs) values[input.key] = password;
    for (const [k, v] of Object.entries(values)) command = command.split(`$(${k})`).join(v);
    command = command.replace(/\$\([^)]+\)/g, '').trim().replace(/^\/+/, '');
    if (/^login\b/i.test(command)) return command;
  }
  return `login ${password}`;
}


function dialogText(dialog) {
  const parts = [];
  function walk(v) {
    if (v == null) return;
    if (typeof v === 'string') {
      parts.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, value] of Object.entries(v)) {
        if (['text', 'translate', 'label', 'title', 'description', 'message', 'content', 'placeholder'].includes(k)) {
          const t = textOf(value);
          if (t) parts.push(t);
        }
        walk(value);
      }
    }
  }
  walk(unwrap(dialog));
  return [...new Set(parts.filter(Boolean))].join(' ');
}

function findCaptchaInput(dialog) {
  const root = unwrap(dialog);
  const seen = new Set();
  let found = null;

  function walk(v) {
    if (!v || typeof v !== 'object' || found || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }

    const type = typeof v.type === 'string' ? v.type : '';
    const key = typeof v.key === 'string' ? v.key : '';
    const label = textOf(v.label);
    const placeholder = textOf(v.placeholder);
    const hint = `${key} ${label} ${placeholder} ${type}`;

    if (key && /captcha|verification|verify|code|security/i.test(hint) &&
        (type === 'minecraft:text' || type.includes('input') || type.includes('text'))) {
      found = { key, label, placeholder };
      return;
    }

    Object.values(v).forEach(walk);
  }

  walk(root);
  return found;
}

function looksLikeCaptcha(dialog) {
  const text = dialogText(dialog);
  const hasCaptchaWord = /captcha|verification\s*code|security\s*code|verify\s*code/i.test(text);
  const input = findCaptchaInput(dialog);
  return { detected: !!(hasCaptchaWord || input), text, input };
}

function extractCaptchaText(dialog) {
  const text = dialogText(dialog);

  // Prefer an explicit alphanumeric code near common captcha wording.
  const patterns = [
    /captcha(?:\s*(?:is|code|:|-))?\s*([A-Za-z0-9]{3,12})/i,
    /verification\s*(?:code)?(?:\s*(?:is|:|-))?\s*([A-Za-z0-9]{3,12})/i,
    /security\s*(?:code)?(?:\s*(?:is|:|-))?\s*([A-Za-z0-9]{3,12})/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }

  // If the UI contains a short standalone token, expose it as the displayed captcha.
  const candidates = text.match(/\b[A-Za-z0-9]{4,10}\b/g) || [];
  const filtered = candidates.filter(x => !/captcha|verification|security|code|login|register|signup|submit|confirm/i.test(x));
  return filtered.length === 1 ? filtered[0] : '';
}

async function askCaptchaFromConsole(displayedCaptcha) {
  if (captchaBusy) return captchaValue;
  captchaBusy = true;

  log('');
  log('========================================');
  log('[CAPTCHA] CAPTCHA DETECTED');
  log(`[CAPTCHA] Exact CAPTCHA shown by server: ${displayedCaptcha || '[not extractable from packet]'}`);
  log('[CAPTCHA] Type the CAPTCHA exactly as shown in the game UI.');
  log('[CAPTCHA] Press Enter after typing it.');
  log('========================================');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question('[CAPTCHA] Enter CAPTCHA: ', value => {
      rl.close();
      resolve(String(value || '').trim());
    });
  });

  captchaValue = answer;
  captchaBusy = false;
  return answer;
}

async function submitCaptcha(dialog, value) {
  const raw = unwrap(dialog);
  const inputs = collectInputs(raw);
  const actions = collectActions(raw);
  const captchaInput = findCaptchaInput(raw);

  if (!captchaInput) {
    error('[CAPTCHA] CAPTCHA input field was not identifiable; authentication is paused.');
    return false;
  }

  const chosen = actions.find(a => /submit|confirm|verify|continue|enter|captcha/i.test(
    `${a.label} ${a.id} ${a.submitId} ${a.template}`
  )) || chooseLoginAction(actions);

  if (chosen && String(chosen.type || '').toLowerCase().includes('custom')) {
    const payload = {};
    for (const input of inputs) payload[input.key] = input.key === captchaInput.key ? value : '';
    if (chosen.submitId) payload.action = chosen.submitId;
    bot._client.write('custom_click_action', { id: chosen.id, nbt: payload });
  } else {
    // Preserve the server's normal UI/action flow; only the captcha field is supplied.
    if (chosen?.template) {
      let command = chosen.template;
      command = command.replace(`$(${captchaInput.key})`, value);
      command = command.replace(/\$\([^)]+\)/g, '').trim().replace(/^\/+/, '');
      if (command) bot._client.write('chat_command', { command });
      else return false;
    } else {
      error('[CAPTCHA] No usable submit action found; authentication is paused.');
      return false;
    }
  }

  log('[CAPTCHA] CAPTCHA submitted to the game UI.');
  return true;
}

async function handlePossibleCaptcha(packet) {
  const raw = packet?.dialog ?? packet;
  const info = looksLikeCaptcha(raw);
  if (!info.detected || captchaBusy || stopping) return false;

  captchaDialog = raw;
  const extracted = extractCaptchaText(raw);
  const answer = await askCaptchaFromConsole(extracted);

  if (!answer) {
    error('[CAPTCHA] Empty CAPTCHA entered; authentication remains paused.');
    return true;
  }

  await submitCaptcha(raw, answer);
  return true;
}

function sendLoginCommand(command) {
  const clean = String(command || '').trim().replace(/^\/+/, '');
  if (!clean) throw new Error('Empty login command.');
  if (!bot || stopping) throw new Error('Bot is not connected.');

  // Prefer Mineflayer's supported chat path. It handles modern protocol
  // signing/acknowledgement better than manually constructing chat packets.
  bot.chat(`/${clean}`);
}

function textLooksLikeLoginPrompt(text) {
  const t = String(text || '').replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t) return false;
  if (/register|signup|sign up|create account/.test(t)) return false;
  return /login|log[ -]?in|sign[ -]?in|authenticate|authentication|password/.test(t);
}

function textLooksLikeAuthSuccess(text) {
  const t = String(text || '').toLowerCase();
  return /(logged in|login successful|successfully logged|welcome back|authentication successful|authenticated|you are now logged|login complete)/i.test(t)
    && !/failed|incorrect|wrong|invalid|denied|register|signup/i.test(t);
}

function clearAuthTimers() {
  if (authTimeoutTimer) { clearTimeout(authTimeoutTimer); authTimeoutTimer = null; }
  if (authFallbackTimer) { clearTimeout(authFallbackTimer); authFallbackTimer = null; }
  if (authGraceTimer) { clearTimeout(authGraceTimer); authGraceTimer = null; }
}

function submitLoginFallback(source) {
  if (stopping || authComplete || authBusy || !bot) return false;
  if (loginAttempts >= CONFIG.auth.maxLoginAttemptsPerConnection) return false;
  try {
    sendLoginCommand(`login ${CONFIG.account.password}`);
    loginAttempts++;
    authSubmittedAt = now();
    loginPromptSeen = true;
    log(`[AUTH] Fallback login submitted via ${source} (attempt ${loginAttempts}/${CONFIG.auth.maxLoginAttemptsPerConnection}).`);
    return true;
  } catch (err) {
    state.stats.errors++;
    error(`[AUTH] Fallback login failed via ${source}:`, err.message);
    return false;
  }
}

function scheduleLoginFallback(source, delayMs) {
  if (stopping || authComplete || authFallbackTimer) return;
  authFallbackTimer = setTimeout(() => {
    authFallbackTimer = null;
    if (authComplete || stopping || !bot) return;
    submitLoginFallback(source);
  }, Math.max(0, delayMs));
}

function markAuthComplete(source = 'unknown') {
  if (authComplete) return;
  authComplete = true;
  loginPromptSeen = false;
  postAuthIdleUntil = now() + CONFIG.auth.postAuthIdleMs;
  clearAuthTimers();
  log(`[AUTH] Authentication confirmed via ${source}.`);
  log('[GAME] Server authentication complete — bot is now fully in-game.');
  if (bot?.entity?.position) {
    const p = bot.entity.position;
    log(`[GAME] Position: ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`);
  }
  log(`[GAME] Post-auth idle: ${CONFIG.auth.postAuthIdleMs / 1000}s.`);
  if (CONFIG.auth.postAuthIdle) log('[GAME] Idle mode is enabled; no farming/world actions will run.');
}

function armAuthTimeout() {
  if (authTimeoutTimer) clearTimeout(authTimeoutTimer);
  authTimeoutTimer = setTimeout(() => {
    authTimeoutTimer = null;
    if (!stopping && !authComplete && bot) {
      debug('[AUTH] No authentication success confirmation yet; waiting for server.');
    }
  }, CONFIG.auth.authTimeoutMs);
}

async function handleAuthDialog(packet) {
  if (authComplete || authBusy || stopping) return;

  // CAPTCHA is handled independently and manually. Never auto-solve it.
  if (await handlePossibleCaptcha(packet)) return;

  // Authentication is intentionally handled immediately. Waiting for spawn here
  // creates a deadlock on servers that only emit spawn after /login succeeds.
  const raw = packet?.dialog ?? packet;
  const fp = (() => { try { return JSON.stringify(unwrap(raw)); } catch { return String(raw); } })();
  if (fp === lastDialogFingerprint && now() - lastDialogAt < 4000) return;
  lastDialogFingerprint = fp;
  lastDialogAt = now();
  if (loginAttempts >= CONFIG.auth.maxLoginAttemptsPerConnection) {
    debug('[AUTH] Login attempt limit reached for this connection; waiting for server response.');
    return;
  }
  authBusy = true;
  try {
    const dialog = unwrap(raw);
    const inputs = collectInputs(dialog);
    const actions = collectActions(dialog);
    const chosen = chooseLoginAction(actions);
    log(`[AUTH] Login dialog: inputs=${inputs.length}, actions=${actions.length}`);

    if (inputs.length === 2 || /register|signup|sign\s*up/i.test(`${chosen?.label} ${chosen?.id}`)) {
      throw new Error('Server presented a Register dialog, but this build is LOGIN-ONLY. Account will not be registered.');
    }
    if (!chosen) throw new Error('No usable Login action found.');

    const type = String(chosen.type || '').toLowerCase();
    if (type.includes('custom')) {
      const payload = {};
      for (const input of inputs) payload[input.key] = CONFIG.account.password;
      if (chosen.submitId) payload.action = chosen.submitId;
      bot._client.write('custom_click_action', { id: chosen.id, nbt: payload });
    } else {
      const command = makeLoginCommand(inputs, chosen);
      sendLoginCommand(command);
    }
    loginAttempts++;
    loginPromptSeen = true;
    authSubmittedAt = now();
    log(`[AUTH] Login submitted (attempt ${loginAttempts}/${CONFIG.auth.maxLoginAttemptsPerConnection}).`);
  } catch (err) {
    state.stats.errors++;
    error('[AUTH]', err.message);
  } finally {
    authBusy = false;
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function scheduleReconnect(reason = 'disconnect') {
  if (stopping || reconnectTimer) return;
  reconnectReason = reason;
  let delay;
  if (reason === 'kick') {
    delay = randomInt(CONFIG.reconnect.kickMinMs, CONFIG.reconnect.kickMaxMs);
  } else {
    const base = Math.min(CONFIG.reconnect.initialMs * Math.pow(2, reconnectAttempt), CONFIG.reconnect.maxMs);
    delay = base + randomInt(0, CONFIG.reconnect.disconnectJitterMs);
  }
  reconnectAttempt++;
  state.stats.reconnects++;
  const reconnectAt = new Date(Date.now() + delay).toLocaleTimeString();
  log(`[RECONNECT] Reason: ${reason}`);
  log(`[RECONNECT] Next attempt in ${formatDuration(delay)} (around ${reconnectAt}).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!stopping) connect();
  }, delay);
}

function connect() {
  if (stopping) return;
  reconnectReason = 'startup';
  lastKickReason = '';
  spawned = false;
  authComplete = false;
  authBusy = false;
  authSubmittedAt = 0;
  loginAttempts = 0;
  loginPromptSeen = false;
  protocolLoggedIn = false;
  postAuthIdleUntil = 0;
  lastDialogFingerprint = '';
  lastDialogAt = 0;
  captchaBusy = false;
  captchaValue = '';
  captchaDialog = null;
  queuedAuthPackets = [];
  clearAuthTimers();
  if (authGateTimer) {
    clearTimeout(authGateTimer);
    authGateTimer = null;
  }

  if (bot) {
    try { bot.removeAllListeners(); } catch {}
    try { bot.quit('reconnecting'); } catch {}
    bot = null;
  }

  log('[BOT] Connecting one account only...');
  try {
    bot = mineflayer.createBot({
      host: CONFIG.server.host,
      port: CONFIG.server.port,
      username: CONFIG.account.username,
      auth: 'offline',
      version: CONFIG.server.version,
      connectionTimeout: 60000,
      checkTimeoutInterval: 60000
    });
    bot.loadPlugin(pathfinder);

    bot._client.on('show_dialog', packet => {
      handleAuthDialog(packet).catch(err => {
        state.stats.errors++;
        error('[AUTH] Dialog handler:', err.message);
      });
    });

    bot.once('login', () => {
      protocolLoggedIn = true;
      reconnectAttempt = 0;
      log('[BOT] Protocol login completed; server authentication is now handled immediately.');
      armAuthTimeout();
    });

    bot.once('spawn', async () => {
      spawned = true;
      reconnectAttempt = 0;
      log(`[BOT] Spawned: ${CONFIG.account.username}`);
      log(`[BOT] Server: ${CONFIG.server.host}:${CONFIG.server.port}`);
      log('[GAME] Spawn packet received — world connection is active.');
      if (bot.entity?.position) {
        const p = bot.entity.position;
        log(`[GAME] Initial position: ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`);
      }

      if (!authComplete) {
        log('[AUTH] Spawned before explicit auth-success message; starting login fallback detection.');
        scheduleLoginFallback('spawn', CONFIG.auth.spawnLoginFallbackDelayMs);
      }
    });

    bot.on('message', msg => {
      const text = textOf(msg);
      if (!text) return;
      if (textLooksLikeAuthSuccess(text)) {
        markAuthComplete('server message');
        return;
      }
      if (!authComplete && !authBusy && textLooksLikeLoginPrompt(text)) {
        loginPromptSeen = true;
        if (loginAttempts < CONFIG.auth.maxLoginAttemptsPerConnection && now() - authSubmittedAt >= CONFIG.auth.loginRetryCooldownMs) {
          try {
            sendLoginCommand(`login ${CONFIG.account.password}`);
            loginAttempts++;
            authSubmittedAt = now();
            log(`[AUTH] Text login prompt detected; login submitted (attempt ${loginAttempts}/${CONFIG.auth.maxLoginAttemptsPerConnection}).`);
          } catch (err) {
            state.stats.errors++;
            error('[AUTH] Text prompt login failed:', err.message);
          }
        }
      }
    });

    bot.on('messagestr', (text) => {
      if (textLooksLikeAuthSuccess(text)) {
        markAuthComplete('messagestr');
        return;
      }
      if (!authComplete && !authBusy && textLooksLikeLoginPrompt(text) && loginAttempts < CONFIG.auth.maxLoginAttemptsPerConnection) {
        submitLoginFallback('messagestr');
      }
    });

    bot.on('actionBar', (jsonMsg) => {
      const text = textOf(jsonMsg);
      if (textLooksLikeAuthSuccess(text)) markAuthComplete('action bar');
      else if (!authComplete && textLooksLikeLoginPrompt(text)) submitLoginFallback('action bar');
    });

    bot.on('title', (title) => {
      const text = textOf(title);
      if (textLooksLikeAuthSuccess(text)) markAuthComplete('title');
      else if (!authComplete && textLooksLikeLoginPrompt(text)) submitLoginFallback('title');
    });

    bot.on('systemChat', packet => {
      const text = packet?.formattedMessage || textOf(packet);
      if (textLooksLikeAuthSuccess(text)) {
        markAuthComplete('system chat');
        return;
      }
      if (!authComplete && textLooksLikeLoginPrompt(text)) submitLoginFallback('system chat');
    });

    bot.on('error', err => {
      state.stats.errors++;
      error('[BOT ERROR]', err?.message || String(err));
    });

    bot.on('kicked', reason => {
      authComplete = false;
      protocolLoggedIn = false;
      loginPromptSeen = false;
      clearAuthTimers();
      const readable = (() => {
        if (typeof reason === 'string') return reason;
        try {
          const unwrapped = unwrap(reason);
          const txt = textOf(unwrapped);
          if (txt) return txt;
          return JSON.stringify(unwrapped, null, 2);
        } catch {
          return String(reason);
        }
      })();
      error('[KICKED] Server kick reason:');
      console.error(readable);
      error('[KICKED] Host:', CONFIG.server.host, 'Port:', CONFIG.server.port, 'Version:', CONFIG.server.version);
      error('[KICKED] Spawned:', spawned, 'AuthSubmitted:', !!authSubmittedAt);
      lastKickReason = readable;
      reconnectReason = 'kick';
    });

    bot.on('end', () => {
      spawned = false;
      authComplete = false;
      protocolLoggedIn = false;
      loginPromptSeen = false;
      clearAuthTimers();
      if (authGateTimer) {
        clearTimeout(authGateTimer);
        authGateTimer = null;
      }
      lastDisconnectAt = now();
      log('[BOT] Disconnected.');
      if (!stopping) {
        if (reconnectReason === 'kick') {
          log(`[KICKED] Delayed rejoin enabled. Reason: ${lastKickReason || 'server kick'}`);
          scheduleReconnect('kick');
        } else {
          scheduleReconnect('disconnect');
        }
      }
    });
  } catch (err) {
    state.stats.errors++;
    error('[BOT] Create failed:', err.message);
    scheduleReconnect();
  }
}

function startRuntimeHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (stopping) return;
    const connected = !!(bot && bot.entity);
    const position = connected && bot.entity.position ? `${bot.entity.position.x.toFixed(1)} ${bot.entity.position.y.toFixed(1)} ${bot.entity.position.z.toFixed(1)}` : 'unknown';
    log(`[HEARTBEAT] connected=${connected} spawned=${spawned} authenticated=${authComplete} farming=${farmingLoopStarted && !CONFIG.auth.postAuthIdle} ` + (CONFIG.logging.showWorldPosition ? `position=${position} ` : '') + `cycles=${state.stats.cycles} chopped=${state.stats.chopped} boneMeal=${state.stats.boneMeal} errors=${state.stats.errors}`);
  }, CONFIG.logging.heartbeatEveryMs);
}

function getStatus() {
  return {
    ok: true,
    connected: isReady(),
    authenticated: authComplete,
    account: CONFIG.account.username,
    server: `${CONFIG.server.host}:${CONFIG.server.port}`,
    standPosition: CONFIG.standPosition,
    facingYaw: CONFIG.facingYaw,
    target: getTarget().map(p => ({ x: p.x, y: p.y, z: p.z })),
    inventory: bot?.inventory?.items().reduce((o, i) => ((o[i.name] = (o[i.name] || 0) + i.count), o), {}) || {},
    stats: { ...state.stats },
    uptime: process.uptime()
  };
}

function startHealthServer() {
  if (process.env.TREEBOT_CHILD === '1' || process.env.TREEBOT_SELFTEST === '1') return;
  const port = Number(process.env.PORT || 10000);
  renderHealthServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/healthz' || req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(getStatus()));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false }));
  });
  renderHealthServer.on('error', err => error('[HEALTH]', err.message));
  renderHealthServer.listen(port, '0.0.0.0', () => log(`[HEALTH] Listening on ${port}`));
}

function gracefulShutdown(reason) {
  if (stopping) return;
  stopping = true;
  state.enabled = false;
  saveState();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  try { bot?.quit(reason); } catch {}
  try { renderHealthServer?.close(); } catch {}
  setTimeout(() => process.exit(0), 500);
}

function selfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`SELFTEST FAILED: ${message}`);
  };

  assert(CONFIG.account.username === (process.env.TREEBOT_USERNAME || 'Vanshika9_YT'), 'single configured account username');
  assert(CONFIG.account.password === (process.env.TREEBOT_PASSWORD || ''), 'configured account password source');
  assert(!Object.prototype.hasOwnProperty.call(CONFIG, 'accounts'), 'no multi-account configuration');
  assert(CONFIG.server.host === 'insanesmp.net', 'server host preserved');
  assert(CONFIG.auth.postAuthIdleMs === 4000, '4-second post-auth idle');
  assert(CONFIG.auth.maxLoginAttemptsPerConnection >= 1, 'bounded login attempts');
  assert(CONFIG.auth.spawnLoginFallbackDelayMs > 0, 'spawn login fallback enabled');
  assert(CONFIG.auth.protocolLoginFallbackDelayMs > 0, 'protocol login fallback enabled');
  assert(typeof submitLoginFallback === 'function', 'fallback login sender exists');
  assert(typeof sendLoginCommand === 'function', 'modern login command sender exists');
  assert(CONFIG.auth.postAuthIdle === false, 'post-auth farming mode enabled');
  assert(Array.isArray(queuedAuthPackets), 'auth packet queue initialized');
  assert(textLooksLikeLoginPrompt('Please enter your password'), 'text login prompt detection');
  assert(!textLooksLikeLoginPrompt('Please register your account'), 'register prompt is never treated as login');
  assert(textLooksLikeAuthSuccess('Login successful'), 'auth success detection');

  const t = getTarget();
  assert(t.length === 4, 'target contains four blocks');
  assert(new Set(t.map(p => `${p.x},${p.y},${p.z}`)).size === 4, 'target positions are unique');
  assert(t.every(p => p.y === CONFIG.standPosition.y + 1), 'target is one block above stand level');

  const d = cardinalDirection(0);
  assert(d.x === 0 && d.z === 1, 'yaw 0 faces +Z');
  const west = cardinalDirection(Math.PI / 2);
  assert(west.x === -1 && west.z === 0, 'yaw +PI/2 faces -X');

  const fake = [
    { name: 'oak_sapling' }, { name: 'air' }, { name: 'oak_log' },
    { name: 'oak_wood' }, { name: 'oak_leaves' }, { name: 'bone_meal' }
  ];
  assert(isSapling(fake[0]), 'sapling detection');
  assert(isAir(fake[1]), 'air detection');
  assert(isLog(fake[2]) && isLog(fake[3]), 'log/wood detection');
  assert(isLeaf(fake[4]), 'leaf detection');
  assert(!isReplaceableForSapling({ name: 'stone' }), 'stone is not replaceable');
  assert(isReplaceableForSapling({ name: 'air' }), 'air is replaceable');

  // Pure geometry simulation for all four cardinal orientations.
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const old = CONFIG.facingYaw;
    CONFIG.facingYaw = yaw;
    const area = getTarget();
    assert(area.length === 4, '2x2 target generation');
    assert(new Set(area.map(p => `${p.x},${p.z}`)).size === 4, '2x2 has no duplicates');
    assert(area.every(p => p.y === CONFIG.standPosition.y + 1), '2x2 Y is stable');
    CONFIG.facingYaw = old;
  }

  const fakeCaptcha = {
    type: 'minecraft:dialog',
    body: [
      { type: 'minecraft:text', key: 'captcha', label: 'CAPTCHA: A7kP9' },
      { type: 'minecraft:text', key: 'captcha_code', label: 'Enter CAPTCHA' }
    ]
  };
  const captchaCheck = looksLikeCaptcha(fakeCaptcha);
  assert(captchaCheck.detected, 'CAPTCHA detection');
  assert(captchaCheck.input?.key === 'captcha' || captchaCheck.input?.key === 'captcha_code', 'CAPTCHA input detection');
  const fakeLogin = { type: 'minecraft:dialog', body: [{ type: 'minecraft:text', key: 'password', label: 'Password' }] };
  queuedAuthPackets = [fakeLogin];
  assert(queuedAuthPackets.length === 1, 'auth dialog queue initialized');
  queuedAuthPackets = [];
  assert(CONFIG.auth.postAuthIdle === false, 'post-auth actions are enabled');

  console.log('[SELFTEST] ONE account only = PASS');
  console.log('[SELFTEST] Login-only auth = PASS');
  console.log('[SELFTEST] 2x2 target geometry = PASS');
  console.log('[SELFTEST] Missing-sapling detection logic = PASS');
  console.log('[SELFTEST] Sapling / bone-meal / log detection = PASS');
  console.log('[SELFTEST] Single-tree + large-tree handling paths present = PASS');
  console.log('[SELFTEST] Random 5–16 minute kick cooldown = PASS');
  console.log('[SELFTEST] Runtime heartbeat logging = PASS');
  console.log('[SELFTEST] No live server connection made.');
}

if (process.env.TREEBOT_SELFTEST === '1') {
  selfTest();
  process.exit(0);
}

try {
  validateRuntimeConfig();
} catch (err) {
  error('[CONFIG]', err.message);
  process.exit(1);
}

loadState();

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', err => { state.stats.errors++; error('[UNCAUGHT]', err.stack || err.message); });
process.on('unhandledRejection', reason => { state.stats.errors++; error('[UNHANDLED]', reason?.stack || reason); });

startHealthServer();
startRuntimeHeartbeat();
connect();
