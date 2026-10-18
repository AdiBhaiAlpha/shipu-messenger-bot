const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

module.exports = {
  config: {
    name: 'imagine',
    version: '1.0.0',
    author: 'ShiPu Ai',
    countDown: 3,
    role: 0,
    category: 'ai',
    aliases: ['generate', 'createimg', 'img', 'gen', 'draw', 'imagineai', 'aiimage', 'art', 'paint'],
    guide: '{pref}imagine <prompt>',
    description: 'Generate high-quality AI images from text prompts using Gemini 3.1 Flash Image Preview (Nano Banana) with fallback support',
    enabled: true
  },

  onStart: async function ({ message, args, event }) {
    const prompt = args.join(' ').trim();
    const prefix = event?.prefixUsed || '#';

    if (!prompt) {
      return await message.reply(
        '🎨 **AI IMAGE GENERATOR (Nano Banana)**\n' +
        '─────────────────────────\n' +
        'Generate stunning high-definition AI art from your imagination!\n\n' +
        '💡 **Usage:**\n' +
        `• \`${prefix}imagine <your prompt text>\`\n\n` +
        '✨ **Examples:**\n' +
        `• \`${prefix}imagine a futuristic cyberpunk city with neon reflections at dusk, 4k ultra detailed\`\n` +
        `• \`${prefix}imagine cute baby panda in space suit floating in nebula, digital art 3d render\`\n` +
        `• \`${prefix}imagine watercolor painting of a serene mountain valley in autumn\`\n` +
        `• \`${prefix}imagine majestic glowing phoenix rising from stardust, fantasy wallpaper\``
      );
    }

    if (prompt.length > 4000) {
      return await message.reply('❌ **Prompt is too long.** Maximum 4000 characters allowed.');
    }

    let loader;
    const cacheDir = path.join(process.cwd(), 'cache');
    await fs.ensureDir(cacheDir);
    const filename = `imagine_${event.messageID || 'msg'}_${Date.now()}.png`;
    const filePath = path.join(cacheDir, filename);

    try {
      if (typeof message.react === 'function') {
        try { await message.react('🎨'); } catch (e) {}
      }

      loader = await message.reply('🧠 **Gemini (Nano Banana)** is generating your image...\n⏳ Rendering high-fidelity visual...');

      let imageBase64 = '';
      let usedModel = 'Gemini 3.1 Flash Image Preview';

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

        for (const model of modelsToTry) {
          try {
            const response = await ai.models.generateContent({
              model,
              contents: {
                parts: [{ text: prompt }]
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
            console.warn(`[Imagine Command] Attempt with ${model} failed:`, modelErr.message);
          }
        }
      }

      // Fallback to Pollinations Flux
      if (!imageBase64) {
        console.warn('[Imagine Command] Gemini API unavailable or quota reached. Engaging Pollinations Flux fallback...');
        usedModel = 'Pollinations Flux (Image Fallback)';

        const polliUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?model=flux&width=1024&height=1024&nologo=true`;
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
        throw new Error('Failed to generate image from both Gemini and fallback image engines.');
      }

      const buffer = Buffer.from(imageBase64, 'base64');
      await fs.writeFile(filePath, buffer);

      const stats = await fs.stat(filePath);
      if (stats.size === 0) {
        throw new Error('Generated image file is empty.');
      }

      if (loader && loader.messageID && typeof message.unsend === 'function') {
        try {
          await message.unsend(loader.messageID);
        } catch (e) {}
      }

      const replyText =
`━━━━━━━━━━━━━━━━━━
🎨 **AI IMAGE GENERATION**
━━━━━━━━━━━━━━━━━━
🧠 **Model:** ${usedModel}
📝 **Prompt:** "${prompt}"

✅ *Created with ShiPu Ai🤖*
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
      console.error('[Imagine Command Error]:', err);
      if (loader && loader.messageID && typeof message.unsend === 'function') {
        try { await message.unsend(loader.messageID); } catch (e) {}
      }
      if (typeof message.react === 'function') {
        try { await message.react('❌'); } catch (e) {}
      }
      return await message.reply(`❌ **Failed to generate image:** ${err.message || 'Please try again later.'}`);
    } finally {
      setTimeout(() => {
        fs.remove(filePath).catch(() => {});
      }, 20000);
    }
  }
};
