const test = require("node:test");
const assert = require("node:assert/strict");

const { createUsageService } = require("../src/services/usage");
const { createPaymentHandlers } = require("../src/handlers/payment");
const { formatPersianDate } = require("../src/utils/format");
const { createFakeStore, createClock, silentLog } = require("./helpers");

const DAY = 24 * 60 * 60 * 1000;
const ADMIN = "999";
const USER = 42;

const config = {
  MONETIZATION_ENABLED: true,
  ADMIN_CHAT_ID: ADMIN,
  ADMIN_CONTACT: "@kooleh_admin",
  SUBSCRIPTION_PRICE_TOMAN: "150000",
  CARD_NUMBER: "6037-9911-2233-4455",
  SUBSCRIPTION_DAYS: 30,
};

function createMockBot({ failSendPhoto = false, failSendTo = null } = {}) {
  const calls = { sendMessage: [], sendPhoto: [], answerCallbackQuery: [], editMessageCaption: [] };
  return {
    calls,
    async sendMessage(chatId, text, opts) {
      if (failSendTo !== null && String(chatId) === String(failSendTo)) throw new Error("bot was blocked by the user");
      calls.sendMessage.push({ chatId, text, opts });
      return { message_id: calls.sendMessage.length };
    },
    async sendPhoto(chatId, photo, opts) {
      if (failSendPhoto) throw new Error("chat not found");
      calls.sendPhoto.push({ chatId, photo, opts });
      return { message_id: 1 };
    },
    async answerCallbackQuery(id, opts) {
      calls.answerCallbackQuery.push({ id, opts });
    },
    async editMessageCaption(text, opts) {
      calls.editMessageCaption.push({ text, opts });
    },
  };
}

function setup(botOptions) {
  const store = createFakeStore();
  const clock = createClock();
  const usage = createUsageService({ store, limit: 3, now: clock, log: silentLog });
  const handlers = createPaymentHandlers({ usage, config, now: clock, log: silentLog });
  const bot = createMockBot(botOptions);
  return { store, clock, usage, handlers, bot };
}

function photoMsg(overrides = {}) {
  return {
    chat: { id: USER },
    from: { id: USER, first_name: "Sara", last_name: "K", username: "sara_k" },
    photo: [{ file_id: "small" }, { file_id: "largest-id" }],
    ...overrides,
  };
}

function adminCallback(action, targetId = USER, chatId = ADMIN) {
  return {
    id: "cb1",
    from: { id: Number(chatId) || 1 },
    message: {
      chat: { id: chatId },
      message_id: 7,
      caption: "💳 رسید پرداخت جدید\n🆔 42",
    },
    data: `pay:${action}:${targetId}`,
  };
}

async function exhaustFreeTier(handlers, bot) {
  for (let i = 0; i < 3; i++) assert.ok(await handlers.gatePremiumFeature(bot, USER, USER));
}

test("paywall shows price, card number and receipt instructions after the 3 free requests", async () => {
  const { handlers, bot } = setup();
  await exhaustFreeTier(handlers, bot);
  assert.equal(bot.calls.sendMessage.length, 0);

  const gate = await handlers.gatePremiumFeature(bot, USER, USER);
  assert.equal(gate, null);

  assert.equal(bot.calls.sendMessage.length, 1);
  const { chatId, text, opts } = bot.calls.sendMessage[0];
  assert.equal(chatId, USER);
  assert.equal(opts.parse_mode, "HTML");
  assert.match(text, /۳ درخواست/);
  assert.match(text, /۱۵۰٬۰۰۰ تومان/);
  assert.match(text, /<code>6037-9911-2233-4455<\/code>/);
  assert.match(text, /عکس/);
  assert.match(text, /۷ روز دیگه/);
});

test("the paywall escapes HTML in configured values", async () => {
  const store = createFakeStore();
  const clock = createClock();
  const usage = createUsageService({ store, limit: 0, now: clock, log: silentLog });
  const handlers = createPaymentHandlers({
    usage,
    config: { ...config, CARD_NUMBER: "<b>1234</b>" },
    now: clock,
    log: silentLog,
  });
  const bot = createMockBot();

  await handlers.gatePremiumFeature(bot, USER, USER);
  assert.match(bot.calls.sendMessage[0].text, /&lt;b&gt;1234&lt;\/b&gt;/);
});

test("subscribers never see the paywall", async () => {
  const { handlers, bot, usage } = setup();
  await usage.activateSubscription(USER, 30);
  for (let i = 0; i < 10; i++) assert.ok(await handlers.gatePremiumFeature(bot, USER, USER));
  assert.equal(bot.calls.sendMessage.length, 0);
});

test("a photo from a user who was not shown the paywall is left for image compression", async () => {
  const { handlers, bot } = setup();
  assert.equal(await handlers.handlePaymentPhoto(bot, photoMsg()), false);
  assert.equal(bot.calls.sendPhoto.length, 0);
  assert.equal(bot.calls.sendMessage.length, 0);
});

test("a receipt photo from a paywalled user is forwarded to the admin with approve/reject buttons", async () => {
  const { handlers, bot } = setup();
  await exhaustFreeTier(handlers, bot);
  await handlers.gatePremiumFeature(bot, USER, USER); // paywall -> pending
  bot.calls.sendMessage.length = 0;

  assert.equal(await handlers.handlePaymentPhoto(bot, photoMsg()), true);

  assert.equal(bot.calls.sendPhoto.length, 1);
  const { chatId, photo, opts } = bot.calls.sendPhoto[0];
  assert.equal(chatId, ADMIN);
  assert.equal(photo, "largest-id");
  assert.match(opts.caption, /Sara K/);
  assert.match(opts.caption, /@sara_k/);
  assert.match(opts.caption, /42/);
  assert.deepEqual(opts.reply_markup.inline_keyboard, [
    [
      { text: "✅ تایید", callback_data: "pay:approve:42" },
      { text: "❌ رد", callback_data: "pay:reject:42" },
    ],
  ]);

  assert.equal(bot.calls.sendMessage.length, 1);
  assert.equal(bot.calls.sendMessage[0].chatId, USER);
  assert.match(bot.calls.sendMessage[0].text, /رسیدت برای بررسی ارسال شد/);
});

test("receipt spam is throttled: a second photo right away is not forwarded again", async () => {
  const { handlers, bot, clock } = setup();
  await exhaustFreeTier(handlers, bot);
  await handlers.gatePremiumFeature(bot, USER, USER);

  await handlers.handlePaymentPhoto(bot, photoMsg());
  clock.advance(3000);
  assert.equal(await handlers.handlePaymentPhoto(bot, photoMsg()), true);
  assert.equal(bot.calls.sendPhoto.length, 1);

  clock.advance(20 * 1000);
  await handlers.handlePaymentPhoto(bot, photoMsg());
  assert.equal(bot.calls.sendPhoto.length, 2);
});

test("if the admin can't be reached the user is told and the photo is still treated as handled", async () => {
  const { handlers, bot } = setup({ failSendPhoto: true });
  await exhaustFreeTier(handlers, bot);
  await handlers.gatePremiumFeature(bot, USER, USER);
  bot.calls.sendMessage.length = 0;

  assert.equal(await handlers.handlePaymentPhoto(bot, photoMsg()), true);
  assert.match(bot.calls.sendMessage[0].text, /مشکل/);
});

test("photos go back to compression once the pending window has expired", async () => {
  const { handlers, bot, clock } = setup();
  await exhaustFreeTier(handlers, bot);
  await handlers.gatePremiumFeature(bot, USER, USER);
  clock.advance(25 * 60 * 60 * 1000);
  assert.equal(await handlers.handlePaymentPhoto(bot, photoMsg()), false);
});

test("admin approve: subscription = now + 30 days, user notified with the expiry date, buttons removed", async () => {
  const { handlers, bot, store, clock } = setup();
  await exhaustFreeTier(handlers, bot);
  await handlers.gatePremiumFeature(bot, USER, USER);
  bot.calls.sendMessage.length = 0;

  const approvedAt = clock();
  await handlers.handlePaymentCallback(bot, adminCallback("approve"), "approve", String(USER));

  const row = store.rows.get(USER);
  assert.equal(Date.parse(row.subscription_expires_at), approvedAt + 30 * DAY);
  assert.equal(row.payment_pending_at, null);

  const notice = bot.calls.sendMessage.find((c) => c.chatId === USER);
  assert.ok(notice, "user should be messaged");
  assert.match(notice.text, /اشتراک کوله فعال شد/);
  assert.ok(notice.text.includes(formatPersianDate(approvedAt + 30 * DAY)), "message includes the expiry date");

  assert.equal(bot.calls.answerCallbackQuery[0].opts.text, "✅ تایید شد");
  assert.equal(bot.calls.editMessageCaption.length, 1);
  assert.deepEqual(bot.calls.editMessageCaption[0].opts.reply_markup, { inline_keyboard: [] });
  assert.match(bot.calls.editMessageCaption[0].text, /تایید شد/);

  // ...and the user now has unlimited use.
  for (let i = 0; i < 5; i++) assert.ok(await handlers.gatePremiumFeature(bot, USER, USER));
});

test("admin reject: user told the payment could not be verified, with the admin contact", async () => {
  const { handlers, bot, store } = setup();
  await exhaustFreeTier(handlers, bot);
  await handlers.gatePremiumFeature(bot, USER, USER);
  bot.calls.sendMessage.length = 0;

  await handlers.handlePaymentCallback(bot, adminCallback("reject"), "reject", String(USER));

  const notice = bot.calls.sendMessage.find((c) => c.chatId === USER);
  assert.match(notice.text, /تایید نشد/);
  assert.match(notice.text, /@kooleh_admin/);
  assert.equal(store.rows.get(USER).subscription_expires_at, null);
  assert.match(bot.calls.editMessageCaption[0].text, /رد شد/);

  // A corrected receipt is still routed to the admin.
  assert.equal(await handlers.handlePaymentPhoto(bot, photoMsg()), true);
  assert.equal(bot.calls.sendPhoto.length, 1);
});

test("callbacks from anyone but the admin chat are refused and change nothing", async () => {
  const { handlers, bot, store } = setup();
  await exhaustFreeTier(handlers, bot);
  await handlers.gatePremiumFeature(bot, USER, USER);
  const before = { ...store.rows.get(USER) };

  await handlers.handlePaymentCallback(bot, adminCallback("approve", USER, "12345"), "approve", String(USER));

  assert.deepEqual(store.rows.get(USER), before);
  assert.equal(bot.calls.answerCallbackQuery[0].opts.show_alert, true);
  assert.equal(bot.calls.sendMessage.filter((c) => c.chatId === USER).length, 1); // only the original paywall
});

test("malformed callback data is rejected", async () => {
  const { handlers, bot, store } = setup();
  await handlers.handlePaymentCallback(bot, adminCallback("approve", "abc"), "approve", "abc");
  await handlers.handlePaymentCallback(bot, adminCallback("approve", "1 OR 1=1"), "approve", "1 OR 1=1");
  await handlers.handlePaymentCallback(bot, adminCallback("wipe"), "wipe", String(USER));
  assert.equal(store.rows.size, 0);
  assert.equal(bot.calls.answerCallbackQuery.length, 3);
});

test("if saving the approval fails, the admin is alerted and the user is not told they're subscribed", async () => {
  const store = createFakeStore();
  const clock = createClock();
  const usage = createUsageService({ store, limit: 3, now: clock, log: silentLog });
  const handlers = createPaymentHandlers({ usage, config, now: clock, log: silentLog });
  const bot = createMockBot();

  store.upsert = async () => {
    throw new Error("db down");
  };
  await handlers.handlePaymentCallback(bot, adminCallback("approve"), "approve", String(USER));

  assert.equal(bot.calls.answerCallbackQuery[0].opts.show_alert, true);
  assert.equal(bot.calls.sendMessage.length, 0);
  assert.equal(bot.calls.editMessageCaption.length, 0);
});

test("if the user has blocked the bot, the admin is told the result was saved anyway", async () => {
  const { handlers, bot, store } = setup({ failSendTo: USER });
  await handlers.handlePaymentCallback(bot, adminCallback("approve"), "approve", String(USER));

  assert.notEqual(store.rows.get(USER).subscription_expires_at, null);
  const adminNote = bot.calls.sendMessage.find((c) => String(c.chatId) === ADMIN);
  assert.match(adminNote.text, /نتونستم به کاربر/);
});

test("with monetization disabled nothing is gated and photos are never treated as receipts", async () => {
  const usage = createUsageService({ store: null, limit: 3, log: silentLog });
  const handlers = createPaymentHandlers({ usage, config: { ...config, MONETIZATION_ENABLED: false }, log: silentLog });
  const bot = createMockBot();

  for (let i = 0; i < 20; i++) assert.ok(await handlers.gatePremiumFeature(bot, USER, USER));
  assert.equal(await handlers.handlePaymentPhoto(bot, photoMsg()), false);
  assert.equal(bot.calls.sendMessage.length, 0);
});

test("REGRESSION: the admin's own account is limited like anyone else (no exemption)", async () => {
  const ADMIN_USER = Number(ADMIN);
  const { handlers, bot } = setup();

  for (let i = 0; i < 3; i++) assert.ok(await handlers.gatePremiumFeature(bot, ADMIN_USER, ADMIN_USER));
  assert.equal(await handlers.gatePremiumFeature(bot, ADMIN_USER, ADMIN_USER), null);
  assert.equal(bot.calls.sendMessage.length, 1);
  assert.match(bot.calls.sendMessage[0].text, /سهمیه‌ی رایگان/);
});

test("the paywall states the price plainly, with no comparison, and mentions inviting friends", async () => {
  const { handlers, bot } = setup();
  await exhaustFreeTier(handlers, bot);
  await handlers.gatePremiumFeature(bot, USER, USER);
  const text = bot.calls.sendMessage[0].text;
  assert.match(text, /💰 قیمت: ۱۵۰٬۰۰۰ تومان در ماه \(۳۰ روز\)\n/);
  assert.doesNotMatch(text, /مترو|بلیط|🚇/);
  assert.match(text, /🎁 دوستانت رو دعوت کن/);
  assert.match(text, /🎁 دعوت دوستان/);
});

test("💳 خرید اشتراک: shows the plain price, card and invite line, and lets the next photo reach the admin", async () => {
  const { handlers, bot, store } = setup();

  await handlers.sendSubscriptionInfo(bot, USER, USER);

  const { text, opts } = bot.calls.sendMessage[0];
  assert.equal(opts.parse_mode, "HTML");
  assert.match(text, /۱۵۰٬۰۰۰ تومان در ماه/);
  assert.doesNotMatch(text, /مترو|بلیط/);
  assert.match(text, /🎁 دوستانت رو دعوت کن/);
  assert.match(text, /<code>6037-9911-2233-4455<\/code>/);
  assert.match(text, /عکس/);
  assert.notEqual(store.rows.get(USER).payment_pending_at, null);

  assert.equal(await handlers.handlePaymentPhoto(bot, photoMsg()), true);
  assert.equal(bot.calls.sendPhoto.length, 1);
});

test("💳 خرید اشتراک: a subscriber sees when the subscription ends instead of payment details", async () => {
  const { handlers, bot, usage, clock } = setup();
  const expiresAt = await usage.activateSubscription(USER, 30);

  await handlers.sendSubscriptionInfo(bot, USER, USER);

  const { text } = bot.calls.sendMessage[0];
  assert.ok(text.includes(formatPersianDate(expiresAt)));
  assert.doesNotMatch(text, /شماره کارت/);
  assert.equal(clock(), clock()); // (clock untouched)
});

test("💳 خرید اشتراک with monetization disabled says everything is free", async () => {
  const usage = createUsageService({ store: null, limit: 3, log: silentLog });
  const handlers = createPaymentHandlers({ usage, config: { ...config, MONETIZATION_ENABLED: false }, log: silentLog });
  const bot = createMockBot();

  await handlers.sendSubscriptionInfo(bot, USER, USER);
  assert.match(bot.calls.sendMessage[0].text, /رایگانه/);
});
