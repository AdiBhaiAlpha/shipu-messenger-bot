const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

module.exports = {
config: {
    name: "say",
    aliases: ["speak", "voice"],
    version: "1.0.0",
    role: 0,
    author: "ShiPu",
    description: "Generate speech/audio from text using Fish Audio via OpenRouter API.",
    usage: "#say [text]",
    cooldown: 5,
},

onStart: async function({ message, args, api }) {
    if (!args || args.length === 0) {
        return message.reply("⚠️ Please provide text to convert to speech.\nUsage: #say [text]");
    }

    const text = args.join(" ").trim();
    if (text.length > 500) {
        return message.reply("⚠️ Text is too long. Please limit to 500 characters.");
    }

    let loadingMessageID = null;

    try {
        const loadingResponse = await message.reply("⏳ Generating voice, please wait...");
        if (loadingResponse && loadingResponse.messageID) {
            loadingMessageID = loadingResponse.messageID;
        }

        // Get API key from config database (if available) or fallback to process.env
        let apiKey = process.env.OPENROUTER_API_KEY;
        try {
            // We use dynamic require for mongoose just to fetch the config if needed
            // But since this is a simple command, let's just use the hardcoded or env one
            // Wait, the prompt says: "Read the latest OpenRouter API key from the AI Configuration Manager."
            // Since we can't import the TS service, we can fetch it via mongoose model directly.
            const { mongoose } = await import('mongoose');
            if (mongoose.models.settings) {
                const doc = await mongoose.models.settings.findOne({ key: 'ai_config' });
                if (doc && doc.value && doc.value.openRouterApiKey) {
                    apiKey = doc.value.openRouterApiKey;
                }
            }
        } catch (e) {
            // Ignore DB error
        }

        if (!apiKey) {
            return message.reply("⚠️ OpenRouter API key is not configured.");
        }

        const model = 'fish-audio/s2.1-pro-free:free';
        
        // Let's just generate the speech
        const response = await axios.post(
            'https://openrouter.ai/api/v1/audio/speech',
            {
                model: model,
                input: text,
                response_format: 'mp3'
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://ai.studio/build',
                    'X-Title': 'ShiPu AI Bot'
                },
                responseType: 'arraybuffer',
                timeout: 30000
            }
        );

        if (!response.data) {
            throw new Error("No audio returned");
        }

        const tempDir = path.join(process.cwd(), 'temp_audio');
        await fs.ensureDir(tempDir);
        const fileName = `speech_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
        const tempFilePath = path.join(tempDir, fileName);
        await fs.writeFile(tempFilePath, Buffer.from(response.data));

        await message.reply(
            {
                body: "🗣️ Voice Generated",
                attachment: fs.createReadStream(tempFilePath)
            },
            () => {
                if (loadingMessageID) {
                    api.unsendMessage(loadingMessageID).catch(console.error);
                }
                fs.unlink(tempFilePath).catch(console.error);
            }
        );

    } catch (error) {
        if (loadingMessageID) {
            api.unsendMessage(loadingMessageID).catch(console.error);
        }
        console.error("[Command: say] Error generating speech:", error);
        return message.reply(`❌ Failed to generate speech: ${error.message || "Unknown error"}`);
    }
}
};
