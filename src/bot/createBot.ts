// Wire BotHandlers into grammY. Kept thin on purpose: all logic is in BotHandlers.

import { Bot, type Context } from 'grammy';
import { BotHandlers, ChatRateLimiter } from './BotHandlers.js';

export function createBot(token: string, handlers: BotHandlers): Bot {
  const bot = new Bot(token);
  const limiter = new ChatRateLimiter();

  // Private chats only (plus the admin chat, which may be a group).
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat ? String(ctx.chat.id) : null;
    if (!chatId) return;
    if (ctx.chat?.type !== 'private' && !handlers.isAdmin(chatId)) return;
    if (!limiter.allow(chatId)) {
      await ctx.reply('Too many requests. Please wait a minute.');
      return;
    }
    await next();
  });

  const reply = (ctx: Context, html: string) =>
    ctx.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  const chat = (ctx: Context) => String(ctx.chat!.id);
  const arg = (ctx: Context) => (typeof ctx.match === 'string' ? ctx.match : '');

  bot.command('start', async (ctx) => reply(ctx, await handlers.start(chat(ctx), arg(ctx))));
  bot.command('help', async (ctx) => reply(ctx, handlers.help(chat(ctx))));
  bot.command('status', async (ctx) => reply(ctx, await handlers.status(chat(ctx), arg(ctx))));
  bot.command('neworder', async (ctx) => reply(ctx, await handlers.newOrder(chat(ctx), arg(ctx))));
  bot.command('review', async (ctx) => reply(ctx, await handlers.review(chat(ctx))));

  bot.catch((err) => {
    console.error('Telegram bot error:', err.error instanceof Error ? err.error.message : err.error);
  });
  return bot;
}
