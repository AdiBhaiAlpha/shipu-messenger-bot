const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

module.exports = {
  config: {
    name: 'gen',
    version: '2.1.0',
    author: 'Chitron Bhattacharjee',
    countDown: 10,
    role: 0,
    category: 'ai',
    guide: '{pref}gen <prompt>',
    description: 'Generate an image from a text prompt using Gemini (Nano Banana) with Pollinations fallback'
  },
  onStart: async function ({ message, args, event }) {
    const prompt = args.join(' ').trim();

    if (!prompt) {
      return message.reply('❌ Please provide a prompt!\n\nExample:\n#gen futuristic cyberpunk city at night');
    }

    if (prompt.length > 4000) {
      return message.reply('❌ Prompt is too long. Maximum 4000 characters allowed.');
    }

    let loader;
    const cacheDir = path.join(__dirname, 'cache');
    const filename = `gen_${event.messageID || 'msg'}_${Date.now()}.png`;
    const filePath = path.join(cacheDir, filename);

    try {
      await fs.ensureDir(cacheDir);

      loader = await message.reply('🧠 Gemini (Nano Banana) is creating your image...\nPlease wait...');

      let imageBase64 = '';
      let usedModel = 'Gemini (Nano Banana)';

      try {
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
        if (!apiKey) {
          throw new Error('GEMINI_API_KEY not found');
        }

        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build'
            }
          }
        });

        const response = await ai.models.generateContent({
          model: 'gemma-4-26b-a4b-it',
          contents: {
            parts: [{ text: prompt }]
          },
          config: {
            imageConfig: {
              aspectRatio: "1:1",
              imageSize: "1K"
            }
          }
        });

        if (response.candidates?.[0]?.content?.parts) {
          for (const part of response.candidates[0].content.parts) {
            if (part.inlineData?.data) {
              imageBase64 = part.inlineData.data;
            }
          }
        }
      } catch (geminiErr) {
        console.warn('[Gen Command] Gemini generation failed or quota exceeded, falling back to Pollinations:', geminiErr.message);
        usedModel = 'Pollinations Flux (Fallback)';
        
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
        throw new Error('Failed to generate image from both Gemini and fallback providers.');
      }

      const buffer = Buffer.from(imageBase64, 'base64');
      await fs.writeFile(filePath, buffer);

      const stats = await fs.stat(filePath);
      if (stats.size === 0) {
        throw new Error('Generated image file is empty.');
      }

      if (loader && loader.messageID) {
        try {
          await message.unsend(loader.messageID);
        } catch {}
      }

      const replyText = 
`━━━━━━━━━━━━━━━━━━
AI IMAGE GENERATION

Model: ${usedModel}
Prompt:
${prompt}

✓ Image generated successfully.
━━━━━━━━━━━━━━━━━━`;

      await message.reply({
        body: replyText,
        attachment: fs.createReadStream(filePath)
      });

      await fs.unlink(filePath).catch(() => {});

    } catch (err) {
      console.error('[Gen Command Error]:', err);
      if (loader && loader.messageID) {
        try {
          await message.unsend(loader.messageID);
        } catch {}
      }
      return message.reply(`❌ Failed to generate image: ${err.message || 'Please try again later.'}`);
    } finally {
      try {
        if (await fs.pathExists(filePath)) {
          await fs.unlink(filePath);
        }
      } catch {}
    }
  }
};
