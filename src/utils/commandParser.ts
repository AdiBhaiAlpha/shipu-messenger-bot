export interface ParsedCommand {
  isCommand: boolean;
  commandName: string | null;
  args: string[];
  rawArgs: string;
  prefixUsed: string | null;
}

const recentBotMessageIds = new Map<string, number>();

// Clean up expired message IDs every 2 minutes (5-minute TTL)
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [id, timestamp] of recentBotMessageIds.entries()) {
      if (now - timestamp > 300000) {
        recentBotMessageIds.delete(id);
      }
    }
  }, 120000);
}

export function recordBotMessageId(messageID: string): void {
  if (messageID && typeof messageID === 'string') {
    recentBotMessageIds.set(messageID, Date.now());
  }
}

export function isBotMessageId(messageID: string): boolean {
  if (!messageID) return false;
  return recentBotMessageIds.has(String(messageID));
}

export function isSelfEvent(event: any, selfUid?: string): boolean {
  if (!event || typeof event !== 'object') return false;

  // 1. Explicit self flag
  if (event.isSelf === true) return true;

  // 2. Outgoing message ID cache check
  const messageID = String(event.messageID || event.messageId || '').trim();
  if (messageID && isBotMessageId(messageID)) {
    return true;
  }

  // 3. Normalize sender ID vs bot authenticated UID
  const senderID = String(
    event.senderID || event.senderId || event.author || event.userID || ''
  ).trim();

  const botUid = String(selfUid || '').trim();

  if (senderID && botUid && senderID === botUid) {
    return true;
  }

  return false;
}

export function parseCommand(body: string, prefix: string): ParsedCommand {
  const notACommand: ParsedCommand = {
    isCommand: false,
    commandName: null,
    args: [],
    rawArgs: '',
    prefixUsed: null
  };

  if (!body || typeof body !== 'string' || !prefix || typeof prefix !== 'string') {
    return notACommand;
  }

  // Normalize leading whitespace
  const normalizedBody = body.trimStart();
  if (!normalizedBody) {
    return notACommand;
  }

  // Support "shipu <message>", "shipu ai <message>", "shipu", "shipu ai", "#shipu <message>", "@shipu on" (mention) triggers
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shipuAiRegex = new RegExp(`^(?:${escapedPrefix}|@)?shipu(?:\\s+ai)?(?:\\s+([\\s\\S]*))?$`, 'i');
  const shipuAiMatch = normalizedBody.match(shipuAiRegex);

  if (shipuAiMatch) {
    const hasPrefix = normalizedBody.toLowerCase().startsWith(prefix.toLowerCase());
    const rawArgs = shipuAiMatch[1] ? shipuAiMatch[1].trim() : '';
    let args: string[] = [];
    if (rawArgs) {
      args = rawArgs.split(/\s+/);
    } else if (!hasPrefix || /\bshipu\s+ai$/i.test(normalizedBody)) {
      // Standalone "shipu" or "shipu ai" triggers "shipu on" to start the session
      args = ['on'];
    }
    return {
      isCommand: true,
      commandName: 'shipu',
      args,
      rawArgs: args.join(' '),
      prefixUsed: hasPrefix ? prefix : null
    };
  }

  // Strict regex: Prefix must be immediately followed by non-whitespace command name
  // Example: "#kick" matches, "# kick" does NOT match
  const commandRegex = new RegExp('^' + escapedPrefix + '([^\\s]+)(?:\\s+([\\s\\S]*))?$');
  const match = normalizedBody.match(commandRegex);

  if (!match) {
    return notACommand;
  }

  const commandName = match[1].toLowerCase();
  const rawArgs = match[2] ? match[2].trim() : '';
  const args = rawArgs ? rawArgs.split(/\s+/) : [];

  return {
    isCommand: true,
    commandName,
    args,
    rawArgs,
    prefixUsed: prefix
  };
}
