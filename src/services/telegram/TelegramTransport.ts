import { telegramLogger } from './TelegramLogger';
import { TelegramUser, TelegramUpdate, TelegramChat } from '../../types/telegram';

export interface TelegramApiResponse<T = any> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: {
    migrate_to_chat_id?: number;
    retry_after?: number;
  };
}

export class TelegramTransport {
  private token: string;
  private readonly baseUrl: string;

  constructor(token: string) {
    this.token = token.trim();
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
  }

  public getToken(): string {
    return this.token;
  }

  public setToken(token: string) {
    this.token = token.trim();
  }

  public async callApi<T = any>(
    method: string,
    payload?: any,
    signal?: AbortSignal,
    timeoutMs: number = 35000,
    isFormData: boolean = false
  ): Promise<TelegramApiResponse<T>> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const controller = new AbortController();

    let isInternalAbort = false;
    const timer = setTimeout(() => {
      isInternalAbort = true;
      controller.abort();
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        controller.abort();
      });
    }

    try {
      if (isFormData && payload) {
        const axios = (await import('axios')).default;
        const headers = typeof payload.getHeaders === 'function' ? payload.getHeaders() : {};
        const response = await axios.post(url, payload, {
          headers: {
            ...headers,
            'User-Agent': 'ShiPu-AI-Telegram-Transport/2.5'
          },
          timeout: timeoutMs,
          signal: controller.signal
        });
        clearTimeout(timer);
        return response.data as TelegramApiResponse<T>;
      }

      const headers: Record<string, string> = {
        'User-Agent': 'ShiPu-AI-Telegram-Transport/2.5'
      };

      let body: string | undefined = undefined;
      if (payload && Object.keys(payload).length > 0) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(payload);
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });

      clearTimeout(timer);

      const json = await res.json() as TelegramApiResponse<T>;
      return json;
    } catch (err: any) {
      clearTimeout(timer);
      if (signal?.aborted || isInternalAbort) {
        throw new Error('REQUEST_ABORTED');
      }
      throw err;
    }
  }

  public async getMe(signal?: AbortSignal): Promise<TelegramApiResponse<TelegramUser>> {
    try {
      const res = await this.callApi<TelegramUser>('getMe', {}, signal, 10000);
      return res;
    } catch (err: any) {
      return {
        ok: false,
        description: err?.message || 'Network error connecting to Telegram API'
      };
    }
  }

  public async getUpdates(
    offset: number = 0,
    timeout: number = 25,
    limit: number = 50,
    signal?: AbortSignal
  ): Promise<TelegramApiResponse<TelegramUpdate[]>> {
    const payload = {
      offset,
      timeout,
      limit,
      allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query']
    };

    // Long poll HTTP timeout should be slightly greater than Telegram poll timeout
    const httpTimeout = (timeout + 10) * 1000;
    return this.callApi<TelegramUpdate[]>('getUpdates', payload, signal, httpTimeout);
  }

  public async sendMessage(
    chatId: number | string,
    text: string,
    options?: {
      replyToMessageId?: number | string;
      parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
      disableWebPagePreview?: boolean;
    }
  ): Promise<TelegramApiResponse<any>> {
    const payload: any = {
      chat_id: chatId,
      text: text || ' '
    };

    if (options?.replyToMessageId) {
      payload.reply_to_message_id = options.replyToMessageId;
    }

    if (options?.parseMode) {
      payload.parse_mode = options.parseMode;
    }

    if (options?.disableWebPagePreview) {
      payload.disable_web_page_preview = true;
    }

    try {
      // First attempt with formatting if requested
      const res = await this.callApi('sendMessage', payload, undefined, 15000);
      if (!res.ok && res.description?.toLowerCase().includes('can\'t parse entities')) {
        // Fallback to plain text on Markdown/HTML entity parsing mismatch
        delete payload.parse_mode;
        return await this.callApi('sendMessage', payload, undefined, 15000);
      }
      return res;
    } catch (err: any) {
      return {
        ok: false,
        description: err?.message || 'Failed to send Telegram message'
      };
    }
  }

  public async sendPhoto(
    chatId: number | string,
    photoSource: string | Buffer | any,
    caption?: string,
    replyToMessageId?: number | string
  ): Promise<TelegramApiResponse<any>> {
    try {
      // Check if it's a Buffer or Readable stream
      if (Buffer.isBuffer(photoSource) || (photoSource && typeof photoSource.pipe === 'function')) {
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('chat_id', String(chatId));
        if (caption) form.append('caption', caption);
        if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));
        form.append('photo', photoSource, { filename: (photoSource as any)?.path ? (await import('path')).basename((photoSource as any).path) : 'photo.jpg' });

        return await this.callApi('sendPhoto', form, undefined, 30000, true);
      }

      const photoStr = String(photoSource);
      const fs = (await import('fs-extra')).default;
      const path = (await import('path')).default;

      if (!photoStr.startsWith('http://') && !photoStr.startsWith('https://') && await fs.pathExists(photoStr)) {
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('chat_id', String(chatId));
        if (caption) form.append('caption', caption);
        if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));
        form.append('photo', fs.createReadStream(photoStr), { filename: path.basename(photoStr) });
        return await this.callApi('sendPhoto', form, undefined, 30000, true);
      }

      const payload: any = {
        chat_id: chatId,
        photo: photoStr
      };
      if (caption) payload.caption = caption;
      if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;

      return await this.callApi('sendPhoto', payload, undefined, 25000);
    } catch (err: any) {
      telegramLogger.warn('API_ERROR', `sendPhoto failed: ${err?.message || err}`);
      return this.sendMessage(chatId, `${caption ? `${caption}\n` : ''}${typeof photoSource === 'string' ? `📷 ${photoSource}` : ''}`, { replyToMessageId });
    }
  }

  public async sendDocument(
    chatId: number | string,
    docSource: string | Buffer | any,
    caption?: string,
    replyToMessageId?: number | string
  ): Promise<TelegramApiResponse<any>> {
    try {
      if (Buffer.isBuffer(docSource) || (docSource && typeof docSource.pipe === 'function')) {
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('chat_id', String(chatId));
        if (caption) form.append('caption', caption);
        if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));
        form.append('document', docSource, { filename: (docSource as any)?.path ? (await import('path')).basename((docSource as any).path) : 'document.bin' });

        return await this.callApi('sendDocument', form, undefined, 35000, true);
      }

      const docStr = String(docSource);
      const fs = (await import('fs-extra')).default;
      const path = (await import('path')).default;

      if (!docStr.startsWith('http://') && !docStr.startsWith('https://') && await fs.pathExists(docStr)) {
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('chat_id', String(chatId));
        if (caption) form.append('caption', caption);
        if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));
        form.append('document', fs.createReadStream(docStr), { filename: path.basename(docStr) });
        return await this.callApi('sendDocument', form, undefined, 35000, true);
      }

      const payload: any = {
        chat_id: chatId,
        document: docStr
      };
      if (caption) payload.caption = caption;
      if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;

      return await this.callApi('sendDocument', payload, undefined, 30000);
    } catch (err: any) {
      telegramLogger.warn('API_ERROR', `sendDocument failed: ${err?.message || err}`);
      return this.sendMessage(chatId, `${caption ? `${caption}\n` : ''}${typeof docSource === 'string' ? `📁 ${docSource}` : ''}`, { replyToMessageId });
    }
  }

  public async sendVideo(
    chatId: number | string,
    videoSource: string | Buffer | any,
    caption?: string,
    replyToMessageId?: number | string
  ): Promise<TelegramApiResponse<any>> {
    try {
      if (Buffer.isBuffer(videoSource) || (videoSource && typeof videoSource.pipe === 'function')) {
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('chat_id', String(chatId));
        if (caption) form.append('caption', caption);
        if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));
        form.append('video', videoSource, { filename: (videoSource as any)?.path ? (await import('path')).basename((videoSource as any).path) : 'video.mp4' });

        return await this.callApi('sendVideo', form, undefined, 45000, true);
      }

      const videoStr = String(videoSource);
      const fs = (await import('fs-extra')).default;
      const path = (await import('path')).default;

      if (!videoStr.startsWith('http://') && !videoStr.startsWith('https://') && await fs.pathExists(videoStr)) {
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('chat_id', String(chatId));
        if (caption) form.append('caption', caption);
        if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));
        form.append('video', fs.createReadStream(videoStr), { filename: path.basename(videoStr) });
        return await this.callApi('sendVideo', form, undefined, 45000, true);
      }

      const payload: any = {
        chat_id: chatId,
        video: videoStr
      };
      if (caption) payload.caption = caption;
      if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;

      return await this.callApi('sendVideo', payload, undefined, 30000);
    } catch (err: any) {
      telegramLogger.warn('API_ERROR', `sendVideo failed: ${err?.message || err}`);
      return this.sendMessage(chatId, `${caption ? `${caption}\n` : ''}${typeof videoSource === 'string' ? `🎥 ${videoSource}` : ''}`, { replyToMessageId });
    }
  }

  public async sendAudio(
    chatId: number | string,
    audioSource: string | Buffer | any,
    caption?: string,
    replyToMessageId?: number | string
  ): Promise<TelegramApiResponse<any>> {
    try {
      if (Buffer.isBuffer(audioSource) || (audioSource && typeof audioSource.pipe === 'function')) {
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('chat_id', String(chatId));
        if (caption) form.append('caption', caption);
        if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));
        form.append('audio', audioSource, { filename: (audioSource as any)?.path ? (await import('path')).basename((audioSource as any).path) : 'audio.mp3' });

        return await this.callApi('sendAudio', form, undefined, 35000, true);
      }

      const audioStr = String(audioSource);
      const fs = (await import('fs-extra')).default;
      const path = (await import('path')).default;

      if (!audioStr.startsWith('http://') && !audioStr.startsWith('https://') && await fs.pathExists(audioStr)) {
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('chat_id', String(chatId));
        if (caption) form.append('caption', caption);
        if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));
        form.append('audio', fs.createReadStream(audioStr), { filename: path.basename(audioStr) });
        return await this.callApi('sendAudio', form, undefined, 35000, true);
      }

      const payload: any = {
        chat_id: chatId,
        audio: audioStr
      };
      if (caption) payload.caption = caption;
      if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;

      return await this.callApi('sendAudio', payload, undefined, 30000);
    } catch (err: any) {
      telegramLogger.warn('API_ERROR', `sendAudio failed: ${err?.message || err}`);
      return this.sendMessage(chatId, `${caption ? `${caption}\n` : ''}${typeof audioSource === 'string' ? `🎵 ${audioSource}` : ''}`, { replyToMessageId });
    }
  }

  public async setMessageReaction(
    chatId: number | string,
    messageId: number | string,
    emoji: string
  ): Promise<TelegramApiResponse<any>> {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: emoji || '👍' }]
    };
    try {
      return await this.callApi('setMessageReaction', payload, undefined, 10000);
    } catch (err: any) {
      return { ok: false, description: err?.message };
    }
  }

  public async sendChatAction(
    chatId: number | string,
    action: 'typing' | 'upload_photo' | 'record_video' | 'upload_video' | 'record_voice' | 'upload_document' = 'typing'
  ): Promise<TelegramApiResponse<any>> {
    try {
      return await this.callApi('sendChatAction', { chat_id: chatId, action }, undefined, 6000);
    } catch {
      return { ok: false };
    }
  }

  public async getChat(chatId: number | string): Promise<TelegramApiResponse<TelegramChat>> {
    try {
      return await this.callApi<TelegramChat>('getChat', { chat_id: chatId }, undefined, 10000);
    } catch (err: any) {
      return { ok: false, description: err?.message };
    }
  }

  public async getChatAdministrators(chatId: number | string): Promise<TelegramApiResponse<any[]>> {
    try {
      return await this.callApi<any[]>('getChatAdministrators', { chat_id: chatId }, undefined, 10000);
    } catch (err: any) {
      return { ok: false, description: err?.message, result: [] };
    }
  }

  public async banChatMember(chatId: number | string, userId: number | string): Promise<TelegramApiResponse<any>> {
    try {
      return await this.callApi('banChatMember', { chat_id: chatId, user_id: userId }, undefined, 10000);
    } catch (err: any) {
      return { ok: false, description: err?.message };
    }
  }

  public async unbanChatMember(chatId: number | string, userId: number | string): Promise<TelegramApiResponse<any>> {
    try {
      return await this.callApi('unbanChatMember', { chat_id: chatId, user_id: userId, only_if_banned: true }, undefined, 10000);
    } catch (err: any) {
      return { ok: false, description: err?.message };
    }
  }
}
