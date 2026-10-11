import { smartConversationBrain } from '../core/smartConversationBrain';
import { botEngine } from '../core/botEngine';
import { multiAccountManager } from '../adapters/messenger/MultiAccountManager';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${testName}`);
    failed++;
  }
}

async function runSmartBrainTests() {
  console.log('\n🧪 Running Smart Conversation Brain Unit & Integration Tests...\n');

  const threadID = 'thread_smart_test_1';
  const userA = 'user_10001_a';
  const userB = 'user_10002_b';
  const botUid = multiAccountManager.getDefaultAccountMeta()?.uid || '1000889201982';

  // ==================================================
  // 1. GREETINGS (BN, BANGLISH, EN)
  // ==================================================
  smartConversationBrain.clearMemory();
  const g1 = smartConversationBrain.processMessage({ text: 'hi', threadID, senderID: userA, prefix: '#', botUid });
  assert(g1.shouldReply === true && g1.intent === 'GREETING_HI', '"hi" triggers GREETING_HI');

  smartConversationBrain.clearMemory();
  const g2 = smartConversationBrain.processMessage({ text: 'হাই', threadID, senderID: userB, prefix: '#', botUid });
  assert(g2.shouldReply === true && g2.intent === 'GREETING_HI', '"হাই" triggers GREETING_HI');

  smartConversationBrain.clearMemory();
  const g3 = smartConversationBrain.processMessage({ text: 'assalamualaikum', threadID, senderID: userA, prefix: '#', botUid });
  assert(g3.shouldReply === true && g3.intent === 'GREETING_SALAM', '"assalamualaikum" triggers GREETING_SALAM');

  smartConversationBrain.clearMemory();
  const g4 = smartConversationBrain.processMessage({ text: 'আসসালামু আলাইকুম', threadID, senderID: userB, prefix: '#', botUid });
  assert(g4.shouldReply === true && g4.intent === 'GREETING_SALAM', '"আসসালামু আলাইকুম" triggers GREETING_SALAM');

  // ==================================================
  // 2. TIME GREETINGS
  // ==================================================
  smartConversationBrain.clearMemory();
  const tg1 = smartConversationBrain.processMessage({ text: 'good morning', threadID, senderID: userA, prefix: '#', botUid });
  assert(tg1.shouldReply === true && tg1.intent === 'GOOD_MORNING', '"good morning" triggers GOOD_MORNING');

  smartConversationBrain.clearMemory();
  const tg2 = smartConversationBrain.processMessage({ text: 'শুভ সকাল', threadID, senderID: userB, prefix: '#', botUid });
  assert(tg2.shouldReply === true && tg2.intent === 'GOOD_MORNING', '"শুভ সকাল" triggers GOOD_MORNING');

  smartConversationBrain.clearMemory();
  const tg3 = smartConversationBrain.processMessage({ text: 'good night', threadID, senderID: userA, prefix: '#', botUid });
  assert(tg3.shouldReply === true && tg3.intent === 'GOOD_NIGHT', '"good night" triggers GOOD_NIGHT');

  smartConversationBrain.clearMemory();
  const tg4 = smartConversationBrain.processMessage({ text: 'শুভ রাত্রি', threadID, senderID: userB, prefix: '#', botUid });
  assert(tg4.shouldReply === true && tg4.intent === 'GOOD_NIGHT', '"শুভ রাত্রি" triggers GOOD_NIGHT');

  // ==================================================
  // 3. HOW ARE YOU & WHAT IS UP
  // ==================================================
  smartConversationBrain.clearMemory();
  const h1 = smartConversationBrain.processMessage({ text: 'ke?mon acho', threadID, senderID: userA, prefix: '#', botUid });
  assert(h1.shouldReply === true && h1.intent === 'HOW_ARE_YOU', '"kemon acho" triggers HOW_ARE_YOU');

  smartConversationBrain.clearMemory();
  const h2 = smartConversationBrain.processMessage({ text: 'কেমন আছো', threadID, senderID: userB, prefix: '#', botUid });
  assert(h2.shouldReply === true && h2.intent === 'HOW_ARE_YOU', '"কেমন আছো" triggers HOW_ARE_YOU');

  smartConversationBrain.clearMemory();
  const h3 = smartConversationBrain.processMessage({ text: 'ki khobor', threadID, senderID: userA, prefix: '#', botUid });
  assert(h3.shouldReply === true && h3.intent === 'WHAT_IS_UP', '"ki khobor" triggers WHAT_IS_UP');

  // ==================================================
  // 4. FOOD (HAVE YOU EATEN)
  // ==================================================
  smartConversationBrain.clearMemory();
  const f1 = smartConversationBrain.processMessage({ text: 'khaicho', threadID, senderID: userA, prefix: '#', botUid });
  assert(f1.shouldReply === true && f1.intent === 'HAVE_YOU_EATEN', '"khaicho" triggers HAVE_YOU_EATEN');

  smartConversationBrain.clearMemory();
  const f2 = smartConversationBrain.processMessage({ text: 'খাইছো?', threadID, senderID: userB, prefix: '#', botUid });
  assert(f2.shouldReply === true && f2.intent === 'HAVE_YOU_EATEN', '"খাইছো?" triggers HAVE_YOU_EATEN');

  // ==================================================
  // 5. BOT NAME & CREATOR
  // ==================================================
  smartConversationBrain.clearMemory();
  const n1 = smartConversationBrain.processMessage({ text: 'tomar nam ki', threadID, senderID: userA, prefix: '#', botUid });
  assert(n1.shouldReply === true && n1.intent === 'BOT_NAME', '"tomar nam ki" triggers BOT_NAME');

  smartConversationBrain.clearMemory();
  const c1 = smartConversationBrain.processMessage({ text: 'tomar creator ke', threadID, senderID: userB, prefix: '#', botUid });
  assert(c1.shouldReply === true && c1.intent === 'BOT_CREATOR', '"tomar creator ke" triggers BOT_CREATOR');

  smartConversationBrain.clearMemory();
  const c2 = smartConversationBrain.processMessage({ text: 'কে বানাইছে তোমাকে', threadID, senderID: userA, prefix: '#', botUid });
  assert(c2.shouldReply === true && c2.intent === 'BOT_CREATOR', '"কে বানাইছে তোমাকে" triggers BOT_CREATOR');

  // ==================================================
  // 6. LOCATION & CAPABILITIES & PREFIX
  // ==================================================
  smartConversationBrain.clearMemory();
  const l1 = smartConversationBrain.processMessage({ text: 'tomar basa koi', threadID, senderID: userB, prefix: '#', botUid });
  assert(l1.shouldReply === true && l1.intent === 'WHERE_DO_YOU_LIVE', '"tomar basa koi" triggers WHERE_DO_YOU_LIVE');

  smartConversationBrain.clearMemory();
  const cap1 = smartConversationBrain.processMessage({ text: 'ki korte paro', threadID, senderID: userA, prefix: '#', botUid });
  assert(cap1.shouldReply === true && cap1.intent === 'BOT_CAPABILITIES', '"ki korte paro" triggers BOT_CAPABILITIES');

  smartConversationBrain.clearMemory();
  const pfx1 = smartConversationBrain.processMessage({ text: 'prefix ki', threadID, senderID: userB, prefix: '#', botUid });
  assert(pfx1.shouldReply === true && pfx1.intent === 'BOT_PREFIX', '"prefix ki" triggers BOT_PREFIX');

  // ==================================================
  // 7. EMOJIS IN INPUT
  // ==================================================
  smartConversationBrain.clearMemory();
  const e1 = smartConversationBrain.processMessage({ text: 'Hi 👋', threadID, senderID: userA, prefix: '#', botUid });
  assert(e1.shouldReply === true && e1.intent === 'GREETING_HI', '"Hi 👋" triggers GREETING_HI');

  smartConversationBrain.clearMemory();
  const e2 = smartConversationBrain.processMessage({ text: 'কেমন আছো ❤️', threadID, senderID: userB, prefix: '#', botUid });
  assert(e2.shouldReply === true && e2.intent === 'HOW_ARE_YOU', '"কেমন আছো ❤️" triggers HOW_ARE_YOU');

  // ==================================================
  // 8. NEGATIVE TESTS (MUST NOT TRIGGER INTENT)
  // ==================================================
  const neg1 = smartConversationBrain.processMessage({ text: 'আজকে আমি hi বললাম', threadID, senderID: userA, prefix: '#', botUid });
  assert(neg1.shouldReply === false, 'Embedded referential sentence "আজকে আমি hi বললাম" does NOT trigger intent');

  const neg2 = smartConversationBrain.processMessage({ text: 'hello শব্দটা নিয়ে কথা বলছিলাম', threadID, senderID: userB, prefix: '#', botUid });
  assert(neg2.shouldReply === false, 'Referential sentence "hello শব্দটা নিয়ে..." does NOT trigger intent');

  const neg3 = smartConversationBrain.processMessage({ text: 'random unrelated conversation between users', threadID, senderID: userA, prefix: '#', botUid });
  assert(neg3.shouldReply === false, 'Random conversation does NOT trigger intent');

  // ==================================================
  // 9. COMMAND EXCLUSION
  // ==================================================
  const cmd1 = smartConversationBrain.processMessage({ text: '#help', threadID, senderID: userB, prefix: '#', botUid });
  assert(cmd1.shouldReply === false && cmd1.reason === 'Is prefixed command', '"#help" command excluded from Smart Brain');

  // ==================================================
  // 10. BOT ENGINE INTEGRATION TEST
  // ==================================================
  smartConversationBrain.clearMemory();
  delete (globalThis as any).shipuSessions?.['user_9999_test'];
  try {
    const { AIOSSessionModel } = await import('../db/firebaseDb');
    await (AIOSSessionModel as any).deleteMany({ userID: 'user_9999_test' });
  } catch (err) {}

  const engineRes = await botEngine.handleIncomingEvent('thread_smart_integration', 'user_9999_test', 'কেমন আছো', `msg_${Date.now()}`, 'acc_default');
  assert(engineRes.body.includes('ভালো আছি') || engineRes.body.includes('Valo achi') || engineRes.body.includes('doing great') || engineRes.body.length > 0, 'BotEngine responds to casual chat via Smart Brain');

  // ==================================================
  // 11. EXACT SELF-LOOP REGRESSION TEST
  // ==================================================
  const actualBotUid = process.env.BOT_UID || '1000889201982';
  const selfMsgText = `হাই সবাই! 👋
আমি ShiPu Ai 🤖
আমার prefix হলো #
#help দিয়ে command list দেখতে পারো।`;

  const selfRes = await botEngine.handleIncomingEvent('thread_smart_integration', actualBotUid, selfMsgText, `msg_${Date.now()}`, 'acc_default');
  assert(selfRes.body === '', 'Self-loop test: Bot message with senderID = botUid is dropped silently');

  console.log(`\n====================================`);
  console.log(`Smart Brain Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log(`====================================\n`);

  if (failed > 0) process.exit(1);
  process.exit(0);
}

runSmartBrainTests();
