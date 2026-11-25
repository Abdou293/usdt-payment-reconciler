// Telegram sender backed by grammY's Bot API client.

import { Api, GrammyError } from 'grammy';
import { PermanentDeliveryError, type TelegramSender } from './NotificationDispatcher.js';

export class GrammyTelegramSender implements TelegramSender {
  constructor(private readonly api: Api) {}

  async sendMessage(chatId: string, html: string): Promise<void> {
    try {
      await this.api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (error) {
      // 400 (bad chat id / bad message) and 403 (user blocked the bot) will never succeed.
      if (error instanceof GrammyError && (error.error_code === 400 || error.error_code === 403)) {
        throw new PermanentDeliveryError(`Telegram ${error.error_code}: ${error.description}`);
      }
      throw error; // 429 / network errors: retry later
    }
  }
}
