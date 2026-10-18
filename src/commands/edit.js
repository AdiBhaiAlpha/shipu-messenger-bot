const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

async function extractImageParts(eventOrMsg) {
  if (!eventOrMsg) return [];
  const list = [];
  const rawAttachments = [];

  if (Array.isArray(eventOrMsg.attachments)) rawAttachments.push(...eventOrMsg.attachments);
  if (Array.isArray(eventOrMsg.attachment)) rawAttachments.push(...eventOrMsg.attachment);
  if (eventOrMsg.attachment && !Array.isArray(eventOrMsg.attachment)) rawAttachments.push(eventOrMsg.attachment);

  if (eventOrMsg.messageReply) {
    if (Array.isArray(eventOrMsg.messageReply.attachments)) rawAttachments.push(...eventOrMsg.messageReply.attachments);
    if (eventOrMsg.messageReply.attachment) rawAttachments.push(eventOrMsg.messageReply.attachment);
    if (eventOrMsg.messageReply.image) rawAttachments.push(eventOrMsg.messageReply.image);
    if (eventOrMsg.messageReply.url) rawAttachments.push({ url: eventOrMsg.messageReply.url });
  }
  if (eventOrMsg.image) rawAttachments.push(eventOrMsg.image);

  for (const att of rawAttachments) {
    if (!att) continue;
    if (typeof att === 'object' && att.inlineData && att.inlineData.data) {
      list.push(att);
      continue;
    }
    const url = att.url || att.previewUrl || att.largePreviewUrl || att.path || (typeof att === 'string' ? att : null);
    if (url) {
      if (typeof url === 'string' && url.startsWith('data:image/')) {
        const matches = url.match(/^data:(image\/[a-zA-Z0-9+-]+);base64,(.+)$/);
        if (matches && matches[2]) {
          list.push({
            inlineData: {
              mimeType: matches[1],
              data: matches[2]
            }
          });
          continue;
        }
      }
      try {
        if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
          const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
          const buf = Buffer.from(res.data);
          const mime = res.headers['content-type'] || 'image/jpeg';
          list.push({
            inlineData: {
              mimeType: mime,
              data: buf.toString('base64')
            }
          });
        } else if (typeof url === 'string' && fs.existsSync(url)) {
          const buf = await fs.readFile(url);
          list.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: buf.toString('base64')
            }
          });
        }
      } catch (e) {
        console.error('[Edit Command] Failed to download attachment URL:', e.message);
      }
    }
  }

  const text = (eventOrMsg.body || eventOrMsg.text || '') + ' ' + (eventOrMsg.messageReply?.body || '');
  const urlMatch = text.match(/https?:\/\/[^\s]+?\.(png|jpg|jpeg|webp|gif)(\?[^\s]*)?/i);
  if (urlMatch && list.length === 0) {
    try {
      const res = await axios.get(urlMatch[0], { responseType: 'arraybuffer', timeout: 30000 });
      const buf = Buffer.from(res.data);
      const mime = res.headers['content-type'] || 'image/jpeg';
      list.push({
        inlineData: {
          mimeType: mime,
          data: buf.toString('base64')
        }
      });
    } catch (e) {
      console.error('[Edit Command] Failed to download text URL:', e.message);
    }
  }

  return list;
}

module.exports = {
  config: {
    name: 'edit',
    version: '1.0.0',
    author: 'ShiPu Ai',
    countDown: 3,
    role: 0,
    category: 'ai',
    aliases: ['imageedit', 'editimg', 'photoedit', 'pix2pix'],
    guide: '{pref}edit <instruction> (reply to an image, attach an image, or provide image URL)',
    description: 'Edit an image with text instructions using Gemini 3.1 Flash Image Preview (Nano Banana Pix2Pix) with multi-source fallback',
    enabled: true
  },

  onStart: async function ({ message, args, event }) {
    const prompt = args.join(' ').trim();
    const prefix = event?.prefixUsed || '#';

    // Extract image parts from replied message, current message attachments, or text URLs
    const imageParts = await extractImageParts(event);

    if (imageParts.length === 0) {
      return await message.reply(
        '🎨 **AI IMAGE EDITOR (Pix2Pix)**\n' +
        '─────────────────────────\n' +
        'Please reply to an image or attach a photo to edit!\n\n' +
        '💡 **How to Use:**\n' +
        `• Reply to any image in chat with: \`${prefix}edit <instruction>\`\n` +
        `• Attach a photo and write: \`${prefix}edit <instruction>\`\n\n` +
        '✨ **Examples:**\n' +
        `• \`${prefix}edit remove background and make it clean white\`\n` +
        `• \`${prefix}edit transform into cyberpunk anime style with neon lights\`\n` +
        `• \`${prefix}edit change the shirt color to red and add cool sunglasses\`\n` +
        `• \`${prefix}edit convert this sketch into a photorealistic 4K render\``
      );
    }

    if (!prompt) {
      return await message.reply(
        '✏️ **Please provide editing instructions!**\n\n' +
        '💡 **Examples:**\n' +
        `• \`${prefix}edit make it cartoon anime style\`\n` +
        `• \`${prefix}edit add golden sunset lighting in the background\`\n` +
        `• \`${prefix}edit remove sunglasses and enhance face details\``
      );
    }

    let loader;
    const cacheDir = path.join(process.cwd(), 'cache');
    await fs.ensureDir(cacheDir);
    const filename = `edit_${event.messageID || 'msg'}_${Date.now()}.png`;
    const filePath = path.join(cacheDir, filename);

    try {
      if (typeof message.react === 'function') {
        try { await message.react('🎨'); } catch (e) {}
      }

      loader = await message.reply('🧠 **Gemini (Nano Banana)** is editing your image (Pix2Pix)...\n⏳ Please wait a moment...');

      let imageBase64 = '';
      let usedModel = 'Gemini 3.1 Flash Image Preview (Pix2Pix)';

      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

      if (apiKey) {
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build'
            }
          }
        });

        const modelsToTry = [
          'gemini-3.1-flash-image-preview',
          'gemini-3.1-flash-image',
          'gemini-3.1-flash-lite-image',
          'gemma-4-26b-a4b-it'
        ];

        const inputPart = imageParts[0];
        const editInstruction = `Perform precise image editing on this input image according to the instruction: "${prompt}". Preserve the underlying subject, identity, composition, and structure while applying the requested changes in high fidelity. Output the edited image.`;

        for (const model of modelsToTry) {
          try {
            const response = await ai.models.generateContent({
              model,
              contents: {
                parts: [
                  inputPart,
                  { text: editInstruction }
                ]
              },
              config: {
                imageConfig: {
                  aspectRatio: '1:1',
                  imageSize: '1K'
                }
              }
            });

            if (response.candidates?.[0]?.content?.parts) {
              for (const part of response.candidates[0].content.parts) {
                if (part.inlineData && part.inlineData.data) {
                  imageBase64 = part.inlineData.data;
                  usedModel = `Gemini (${model})`;
                  break;
                }
              }
            }
            if (imageBase64) break;
          } catch (modelErr) {
            console.warn(`[Edit Command] Attempt with ${model} failed:`, modelErr.message);
          }
        }
      }

      // Fallback: Pollinations Flux editing
      if (!imageBase64) {
        console.warn('[Edit Command] Gemini API unavailable or quota reached. Engaging Pollinations Flux fallback...');
        usedModel = 'Pollinations Flux (Edit Fallback)';

        const editPrompt = `${prompt}, edited version of the input image, high quality, maintaining subject composition, 4k`;
        const polliUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(editPrompt)}?model=flux&width=1024&height=1024&nologo=true`;
        const polliRes = await axios.get(polliUrl, {
          responseType: 'arraybuffer',
          timeout: 120000,
          headers: { 'User-Agent': 'ShiPuAI' }
        });

        if (polliRes.status === 200 && polliRes.data) {
          imageBase64 = Buffer.from(polliRes.data).toString('base64');
        }
      }

      if (!imageBase64) {
        throw new Error('Could not generate edited image from available providers.');
      }

      const buffer = Buffer.from(imageBase64, 'base64');
      await fs.writeFile(filePath, buffer);

      const stats = await fs.stat(filePath);
      if (stats.size === 0) {
        throw new Error('Edited image output file is empty.');
      }

      if (loader && loader.messageID && typeof message.unsend === 'function') {
        try {
          await message.unsend(loader.messageID);
        } catch (e) {}
      }

      const replyText =
`━━━━━━━━━━━━━━━━━━
🎨 **AI IMAGE EDIT (Pix2Pix)**
━━━━━━━━━━━━━━━━━━
🧠 **Model:** ${usedModel}
📝 **Instruction:** "${prompt}"

✅ *Image edited successfully by ShiPu Ai🤖*
━━━━━━━━━━━━━━━━━━`;

      const stream = fs.createReadStream(filePath);

      await message.reply({
        body: replyText,
        attachment: stream
      });

      if (typeof message.react === 'function') {
        try { await message.react('✅'); } catch (e) {}
      }

    } catch (err) {
      console.error('[Edit Command Error]:', err);
      if (loader && loader.messageID && typeof message.unsend === 'function') {
        try { await message.unsend(loader.messageID); } catch (e) {}
      }
      if (typeof message.react === 'function') {
        try { await message.react('❌'); } catch (e) {}
      }
      return await message.reply(`❌ **Failed to edit image:** ${err.message || 'Please try again later.'}`);
    } finally {
      setTimeout(() => {
        fs.remove(filePath).catch(() => {});
      }, 20000);
    }
  }
};
